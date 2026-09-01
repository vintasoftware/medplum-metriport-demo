// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { AuditEvent, Patient } from '@medplum/fhirtypes';

/**
 * Creates a Metriport embed token for one patient chart.
 *
 * The Metriport API key is a project secret, so the token must be created here and never in the
 * browser. The bot resolves the Metriport patient ID from the Medplum Patient identifiers, so the
 * caller cannot choose which Metriport patient to open.
 *
 * Input: `{ patientId: <Medplum Patient id> }`
 *
 * Secrets:
 * - `METRIPORT_API_KEY` (required)
 * - `METRIPORT_ENV` ("sandbox" | "production", default "sandbox")
 * - `METRIPORT_TOKEN_EXPIRATION_SECONDS` (default 900, max 36000)
 *
 * https://docs.metriport.com/medical-api/getting-started/embedding
 */
// Same system used by the Medplum Metriport bots in examples/medplum-demo-bots.
export const METRIPORT_PATIENT_IDENTIFIER_SYSTEM = 'https://metriport.com/fhir/identifiers/patient-id';

const MAX_EXPIRATION_SECONDS = 36000; // Metriport hard limit: 10 hours.
const DEFAULT_EXPIRATION_SECONDS = 900;

const ENVIRONMENTS = {
  sandbox: {
    apiBaseUrl: 'https://api.sandbox.metriport.com',
    embedBaseUrl: 'https://ehr.sandbox.metriport.com/embed/app',
  },
  production: {
    apiBaseUrl: 'https://api.metriport.com',
    embedBaseUrl: 'https://ehr.metriport.com/embed/app',
  },
} as const;

type MetriportEnvironment = keyof typeof ENVIRONMENTS;

function isMetriportEnvironment(value: string): value is MetriportEnvironment {
  return value in ENVIRONMENTS;
}

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

  // Only staff may open the embedded chart. Patients and other bots are rejected.
  const requesterType = event.requester?.reference?.split('/')[0];
  if (requesterType !== 'Practitioner') {
    throw new Error('Not authorized to create a Metriport embed token');
  }

  const environment = getSecret(event, 'METRIPORT_ENV') ?? 'sandbox';
  if (!isMetriportEnvironment(environment)) {
    throw new Error(`Invalid METRIPORT_ENV "${environment}". Use "sandbox" or "production".`);
  }

  const apiKey = getSecret(event, 'METRIPORT_API_KEY');
  if (!apiKey) {
    throw new Error('METRIPORT_API_KEY project secret is not set');
  }

  const expirationInSeconds = Math.min(
    Number(getSecret(event, 'METRIPORT_TOKEN_EXPIRATION_SECONDS') ?? DEFAULT_EXPIRATION_SECONDS),
    MAX_EXPIRATION_SECONDS
  );

  // `readResource` runs with the bot identity, so the patient is read regardless of the caller.
  // Restrict who may run this bot with an AccessPolicy on the bot's ProjectMembership.
  const patient: Patient = await medplum.readResource('Patient', patientId);
  const metriportPatientId = patient.identifier?.find((id) => id.system === METRIPORT_PATIENT_IDENTIFIER_SYSTEM)?.value;

  if (!metriportPatientId) {
    return { status: 'not-linked' };
  }

  const { apiBaseUrl, embedBaseUrl } = ENVIRONMENTS[environment];

  const response = await fetch(`${apiBaseUrl}/medical/v1/token/embed`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expirationInSeconds }),
  });

  if (!response.ok) {
    // The upstream body can carry account details, so only the status is reported.
    throw new Error(`Metriport returned ${response.status} while creating the embed token`);
  }

  const { token } = (await response.json()) as { token?: string };
  if (!token) {
    throw new Error('Metriport response did not include a token');
  }

  // Access to a chart is auditable. Written before the token is returned, so a failed audit
  // fails the request. References only, no PHI values.
  await writeAuditEvent(medplum, event, patientId, metriportPatientId);

  return {
    status: 'ok',
    token,
    embedBaseUrl,
    metriportPatientId,
    environment,
    expiresInSeconds: expirationInSeconds,
  };
}

function getSecret(event: BotEvent<MetriportEmbedTokenInput>, name: string): string | undefined {
  const value = event.secrets[name]?.valueString?.trim();
  return value ? value : undefined;
}

async function writeAuditEvent(
  medplum: MedplumClient,
  event: BotEvent<MetriportEmbedTokenInput>,
  patientId: string,
  metriportPatientId: string
): Promise<void> {
  await medplum.createResource<AuditEvent>({
    resourceType: 'AuditEvent',
    type: {
      system: 'http://dicom.nema.org/resources/ontology/DCM',
      code: '110110',
      display: 'Patient Record',
    },
    subtype: [{ system: 'http://hl7.org/fhir/restful-interaction', code: 'read' }],
    action: 'R',
    recorded: new Date().toISOString(),
    outcome: '0',
    outcomeDesc: 'Metriport embed token issued',
    agent: [
      {
        who: event.requester,
        requestor: true,
      },
    ],
    source: { observer: event.bot },
    entity: [
      {
        what: { reference: `Patient/${patientId}` },
        // The Metriport patient ID is an opaque identifier, not PHI.
        detail: [{ type: 'metriportPatientId', valueString: metriportPatientId }],
      },
    ],
  });
}
