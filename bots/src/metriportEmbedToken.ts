// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { MetriportEnvironment } from './shared/metriport';
import {
  getMetriportConfig,
  getMetriportPatientId,
  getSecret,
  metriportRequest,
  requirePractitioner,
  writeMetriportAuditEvent,
} from './shared/metriport';

/**
 * Creates a Metriport embed token for one patient chart.
 *
 * The Metriport API key is a project secret, so the token must be created here and never in the
 * browser. The bot resolves the Metriport patient ID from the Medplum Patient identifiers, so the
 * caller cannot choose which Metriport patient to open.
 *
 * Input: `{ patientId: <Medplum Patient id> }`
 *
 * Secrets, in addition to those in ./shared/metriport:
 * - `METRIPORT_TOKEN_EXPIRATION_SECONDS` (default 900, max 36000)
 *
 * https://docs.metriport.com/medical-api/getting-started/embedding
 */
const MAX_EXPIRATION_SECONDS = 36000; // Metriport hard limit: 10 hours.
const DEFAULT_EXPIRATION_SECONDS = 900;

export interface MetriportEmbedTokenInput {
  patientId: string;
}

export type MetriportEmbedTokenOutput =
  | {
      status: 'ok';
      token: string;
      embedBaseUrl: string;
      metriportPatientId: string;
      environment: MetriportEnvironment;
      expiresInSeconds: number;
    }
  | {
      /** The Medplum Patient has no Metriport identifier, so there is nothing to show yet. */
      status: 'not-linked';
    };

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<MetriportEmbedTokenInput>
): Promise<MetriportEmbedTokenOutput> {
  const patientId = event.input?.patientId;
  if (!patientId) {
    throw new Error('Missing patientId');
  }

  requirePractitioner(event, 'create a Metriport embed token');

  const config = getMetriportConfig(event);
  const expirationInSeconds = Math.min(
    Number(getSecret(event, 'METRIPORT_TOKEN_EXPIRATION_SECONDS') ?? DEFAULT_EXPIRATION_SECONDS),
    MAX_EXPIRATION_SECONDS
  );

  // `readResource` runs with the bot identity, so the patient is read regardless of the caller.
  // Restrict who may run this bot with an AccessPolicy on the bot's ProjectMembership.
  const patient = await medplum.readResource('Patient', patientId);
  const metriportPatientId = getMetriportPatientId(patient);

  if (!metriportPatientId) {
    return { status: 'not-linked' };
  }

  const { token } = await metriportRequest<{ token?: string }>(config, '/medical/v1/token/embed', {
    expirationInSeconds,
  });

  if (!token) {
    throw new Error('Metriport response did not include a token');
  }

  // Access to a chart is auditable. Written before the token is returned, so a failed audit
  // fails the request.
  await writeMetriportAuditEvent(medplum, event, 'record-access', {
    patientId,
    metriportPatientId,
    description: 'Metriport embed token issued',
  });

  return {
    status: 'ok',
    token,
    embedBaseUrl: config.embedBaseUrl,
    metriportPatientId,
    environment: config.environment,
    expiresInSeconds: expirationInSeconds,
  };
}
