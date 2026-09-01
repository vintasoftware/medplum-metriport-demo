// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';

// Bot that creates a short-lived Metriport embed token for one patient. The bot is located by name
// so the same code works in every project and deploy, with no hardcoded Bot ID. The Metriport API
// key lives in the bot secrets, so it never reaches the browser.
// See bots/src/metriportEmbedToken.ts.
export const METRIPORT_EMBED_TOKEN_BOT_NAME = 'metriport-embed-token';

// Identifier that links a Medplum Patient to a Metriport patient. Same system used by the
// Metriport bots in the Medplum repo (examples/medplum-demo-bots).
export const METRIPORT_PATIENT_IDENTIFIER_SYSTEM = 'https://metriport.com/fhir/identifiers/patient-id';

/** Mirrors the bot response in bots/src/metriportEmbedToken.ts. */
export type MetriportEmbedSession =
  | {
      status: 'ok';
      token: string;
      embedBaseUrl: string;
      metriportPatientId: string;
      environment: 'sandbox' | 'production';
      expiresInSeconds: number;
    }
  | { status: 'not-linked' };

/**
 * Creates a Metriport embed session for a patient chart.
 *
 * @param medplum - The Medplum client.
 * @param botId - The `metriport-embed-token` bot ID, resolved by name at runtime.
 * @param patientId - The Medplum Patient ID whose chart is open.
 * @returns The embed session, or a not-linked result when the patient has no Metriport identifier.
 */
export async function createMetriportEmbedSession(
  medplum: MedplumClient,
  botId: string,
  patientId: string
): Promise<MetriportEmbedSession> {
  return medplum.executeBot(botId, { patientId }, 'application/json');
}

/**
 * Builds the Metriport embedded patient view URL.
 *
 * The token goes in the URL fragment, as the Metriport docs require, so it is never sent to a
 * server as a query parameter.
 *
 * @param session - An `ok` embed session returned by the bot.
 * @returns The URL to load in the iframe.
 * @see https://docs.metriport.com/medical-api/getting-started/embedding
 */
export function buildMetriportPatientEmbedUrl(session: Extract<MetriportEmbedSession, { status: 'ok' }>): string {
  const patientPath = encodeURIComponent(session.metriportPatientId);
  return `${session.embedBaseUrl}/patient/${patientPath}#access_token=${session.token}`;
}
