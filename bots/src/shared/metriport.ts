// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { AuditEvent, Patient } from '@medplum/fhirtypes';

/**
 * Shared pieces of the Metriport bots: environment table, secrets, HTTP, and audit.
 *
 * https://docs.metriport.com/medical-api
 */

// Same system used by the Metriport bots in examples/medplum-demo-bots.
export const METRIPORT_PATIENT_IDENTIFIER_SYSTEM = 'https://metriport.com/fhir/identifiers/patient-id';

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

export type MetriportEnvironment = keyof typeof ENVIRONMENTS;

function isMetriportEnvironment(value: string): value is MetriportEnvironment {
  return value in ENVIRONMENTS;
}

export interface MetriportConfig {
  environment: MetriportEnvironment;
  apiBaseUrl: string;
  embedBaseUrl: string;
  apiKey: string;
}

export function getSecret(event: BotEvent<unknown>, name: string): string | undefined {
  const value = event.secrets[name]?.valueString?.trim();
  return value ? value : undefined;
}

/**
 * Reads the Metriport configuration from the project secrets.
 *
 * Sandbox tokens only work with sandbox URLs, so the API and embed hosts are always taken from the
 * same environment as the key.
 *
 * @param event - The bot event carrying the project secrets.
 * @returns The environment hosts and the API key.
 */
export function getMetriportConfig(event: BotEvent<unknown>): MetriportConfig {
  const environment = getSecret(event, 'METRIPORT_ENV') ?? 'sandbox';
  if (!isMetriportEnvironment(environment)) {
    throw new Error(`Invalid METRIPORT_ENV "${environment}". Use "sandbox" or "production".`);
  }

  const apiKey = getSecret(event, 'METRIPORT_API_KEY');
  if (!apiKey) {
    throw new Error('METRIPORT_API_KEY project secret is not set');
  }

  return { environment, ...ENVIRONMENTS[environment], apiKey };
}

/**
 * Rejects callers who are not clinical staff.
 *
 * Bots run with their own identity, so this is the only check on who asked. Also restrict who may
 * execute the bot with an AccessPolicy on the bot's ProjectMembership.
 *
 * @param event - The bot event carrying the requester.
 * @param action - What the caller tried to do, for the error message.
 */
export function requirePractitioner(event: BotEvent<unknown>, action: string): void {
  const requesterType = event.requester?.reference?.split('/')[0];
  if (requesterType !== 'Practitioner') {
    throw new Error(`Not authorized to ${action}`);
  }
}

export class MetriportApiError extends Error {
  constructor(
    readonly status: number,
    path: string,
    detail?: string
  ) {
    super(detail ? `Metriport: ${detail} (${status} for ${path})` : `Metriport returned ${status} for ${path}`);
    this.name = 'MetriportApiError';
  }
}

/**
 * Reads the human-readable reason out of a Metriport error response.
 *
 * Metriport reports validation failures as `{ title, detail }`, where detail names the failing
 * field path, for example "Zip must be a string consisting of 5 numbers, on [address,0,zip]". It
 * carries field paths, never the values, so it is safe to pass on to the caller.
 *
 * @param response - The failed response.
 * @returns The reason, or undefined when the body is not a Metriport error.
 */
async function readErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { title?: string; detail?: string };
    return body.detail ?? body.title;
  } catch {
    return undefined;
  }
}

/**
 * Calls the Metriport API with the project API key.
 *
 * @param config - The Metriport configuration.
 * @param path - Path below the API host, starting with a slash.
 * @param body - JSON request body. Omit for a GET.
 * @returns The parsed response body.
 * @throws MetriportApiError when the response is not ok, so callers can act on the status.
 */
export async function metriportRequest<T>(config: MetriportConfig, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-api-key': config.apiKey, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    throw new MetriportApiError(response.status, path, await readErrorDetail(response));
  }

  return (await response.json()) as T;
}

export function getMetriportPatientId(patient: Patient): string | undefined {
  return patient.identifier?.find((id) => id.system === METRIPORT_PATIENT_IDENTIFIER_SYSTEM)?.value;
}

const AUDIT_TYPES = {
  /** Staff opened Metriport data for a patient. */
  'record-access': { code: '110110', display: 'Patient Record', action: 'R' },
  /** Patient data left Medplum for Metriport. */
  disclosure: { code: '110106', display: 'Export', action: 'E' },
} as const;

export interface MetriportAuditDetails {
  patientId: string;
  description: string;
  metriportPatientId?: string;
}

/**
 * Records a Metriport interaction as an AuditEvent.
 *
 * References and opaque IDs only: no names, dates of birth, or other PHI values.
 *
 * @param medplum - The Medplum client.
 * @param event - The bot event, for the requester and bot references.
 * @param kind - Whether data was read for staff or disclosed to Metriport.
 * @param details - The patient reference and a short description.
 */
export async function writeMetriportAuditEvent(
  medplum: MedplumClient,
  event: BotEvent<unknown>,
  kind: keyof typeof AUDIT_TYPES,
  details: MetriportAuditDetails
): Promise<void> {
  const { code, display, action } = AUDIT_TYPES[kind];

  await medplum.createResource<AuditEvent>({
    resourceType: 'AuditEvent',
    type: { system: 'http://dicom.nema.org/resources/ontology/DCM', code, display },
    action,
    recorded: new Date().toISOString(),
    outcome: '0',
    outcomeDesc: details.description,
    agent: [{ who: event.requester, requestor: true }],
    source: { observer: event.bot },
    entity: [
      {
        what: { reference: `Patient/${details.patientId}` },
        ...(details.metriportPatientId && {
          // The Metriport patient ID is an opaque identifier, not PHI.
          detail: [{ type: 'metriportPatientId', valueString: details.metriportPatientId }],
        }),
      },
    ],
  });
}
