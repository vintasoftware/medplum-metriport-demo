// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient, WithId } from '@medplum/core';
import type { Organization, Patient } from '@medplum/fhirtypes';
import type { MetriportDemographics } from './shared/demographics';
import { buildDemographics } from './shared/demographics';
import type { MetriportConfig } from './shared/metriport';
import {
  getMetriportConfig,
  getMetriportPatientId,
  getSecret,
  METRIPORT_PATIENT_IDENTIFIER_SYSTEM,
  MetriportApiError,
  metriportRequest,
  requirePractitioner,
  writeMetriportAuditEvent,
} from './shared/metriport';

/**
 * Links a Medplum Patient to a Metriport patient, and stores the Metriport ID on the Patient.
 *
 * Matching sends demographics to Metriport, which is a disclosure to a third party, so the caller
 * must be clinical staff and every attempt is recorded as an AuditEvent. Metriport validates the
 * demographics and names the field it rejects, so that error is passed on rather than re-checked
 * here.
 *
 * After linking, a network query is started, so Metriport searches the health data networks for the
 * patient's records. Registering a patient does not query on its own.
 *
 * Input: `{ patientId, create? }`
 *
 * Secrets, in addition to those in ./shared/metriport:
 * - `METRIPORT_FACILITY_ID` (needed to create; falls back to the managing Organization identifier)
 * - `METRIPORT_NETWORK_QUERY_SOURCES` (comma separated: hie, pharmacy, lab. Default hie)
 *
 * https://docs.metriport.com/medical-api/api-reference/patient/match-patient
 * https://docs.metriport.com/medical-api/api-reference/patient/create-patient
 * https://docs.metriport.com/medical-api/api-reference/network/start-network-query
 */
const METRIPORT_ORGANIZATION_IDENTIFIER_SYSTEM = 'https://metriport.com/fhir/identifiers/organization-id';

// Pharmacy and lab are available too, but only HIE returns data for the sandbox personas.
const DEFAULT_NETWORK_QUERY_SOURCES = 'hie';

export interface MetriportLinkPatientInput {
  patientId: string;
  /** Create the patient in Metriport when no match is found. Defaults to false. */
  create?: boolean;
}

export type MetriportLinkPatientOutput =
  | { status: 'linked'; metriportPatientId: string }
  /** Metriport has no patient matching these demographics, and `create` was not requested. */
  | { status: 'no-match' };

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<MetriportLinkPatientInput>
): Promise<MetriportLinkPatientOutput> {
  const { patientId, create = false } = event.input ?? {};
  if (!patientId) {
    throw new Error('Missing patientId');
  }

  requirePractitioner(event, 'link a patient to Metriport');

  const patient = await medplum.readResource('Patient', patientId);

  // Already linked. Callers can run this on every chart open.
  const existingId = getMetriportPatientId(patient);
  if (existingId) {
    return { status: 'linked', metriportPatientId: existingId };
  }

  const demographics = buildDemographics(patient);

  const config = getMetriportConfig(event);
  let metriportPatientId = await matchPatient(config, demographics);
  let created = false;

  if (!metriportPatientId) {
    if (!create) {
      await writeMetriportAuditEvent(medplum, event, 'disclosure', {
        patientId,
        description: 'Metriport patient match attempted, no match found',
      });
      return { status: 'no-match' };
    }

    const facilityId = await getFacilityId(medplum, event, patient);
    const response = await metriportRequest<{ id: string }>(
      config,
      `/medical/v1/patient?facilityId=${encodeURIComponent(facilityId)}`,
      { ...demographics, externalId: patientId }
    );
    metriportPatientId = response.id;
    created = true;
  }

  await linkPatient(medplum, patient, metriportPatientId);

  const networkQueryRequestId = await startNetworkQuery(config, event, metriportPatientId, patientId);

  const linkDescription = created
    ? 'Patient created in Metriport and linked'
    : 'Patient matched in Metriport and linked';

  await writeMetriportAuditEvent(medplum, event, 'disclosure', {
    patientId,
    metriportPatientId,
    description: networkQueryRequestId ? `${linkDescription}, network query started` : linkDescription,
  });

  return { status: 'linked', metriportPatientId };
}

/**
 * Asks Metriport to search the health data networks for this patient's records.
 *
 * The patient is already linked at this point, so a failure here is reported but does not undo the
 * link: the chart still opens, and the query can be started again.
 *
 * @param config - The Metriport configuration.
 * @param event - The bot event, for the sources secret.
 * @param metriportPatientId - The Metriport patient to search for.
 * @param medplumPatientId - Sent as metadata, so the result webhook can find its way back.
 * @returns The Metriport request ID, or undefined when the query could not be started.
 */
async function startNetworkQuery(
  config: MetriportConfig,
  event: BotEvent<MetriportLinkPatientInput>,
  metriportPatientId: string,
  medplumPatientId: string
): Promise<string | undefined> {
  const sources = (getSecret(event, 'METRIPORT_NETWORK_QUERY_SOURCES') ?? DEFAULT_NETWORK_QUERY_SOURCES)
    .split(',')
    .map((source) => source.trim())
    .filter(Boolean);

  try {
    const response = await metriportRequest<{ requestId: string }>(
      config,
      `/medical/v1/network/query?patientId=${encodeURIComponent(metriportPatientId)}`,
      // The webhook that delivers the results has no other way back to the Medplum patient.
      { sources, metadata: { medplumPatientId } }
    );
    return response.requestId;
  } catch (err) {
    // Status only: the message carries no patient data, and the link itself stands.
    console.error(`[metriport] could not start the network query: ${err instanceof Error ? err.message : 'unknown'}`);
    return undefined;
  }
}

/**
 * @param config - The Metriport configuration.
 * @param demographics - The patient demographics to match on.
 * @returns The Metriport patient ID, or undefined when Metriport has no match.
 */
async function matchPatient(config: MetriportConfig, demographics: MetriportDemographics): Promise<string | undefined> {
  try {
    const matched = await metriportRequest<{ id: string }>(config, '/medical/v1/patient/match', demographics);
    return matched.id;
  } catch (err) {
    // Match returns 404 when no patient matches, which is an expected outcome, not a failure.
    if (err instanceof MetriportApiError && err.status === 404) {
      return undefined;
    }
    throw err;
  }
}

/**
 * @param medplum - The Medplum client.
 * @param event - The bot event, for the facility secret.
 * @param patient - The Medplum Patient, for the managing Organization fallback.
 * @returns The Metriport facility ID to create the patient under.
 */
async function getFacilityId(
  medplum: MedplumClient,
  event: BotEvent<MetriportLinkPatientInput>,
  patient: Patient
): Promise<string> {
  const fromSecret = getSecret(event, 'METRIPORT_FACILITY_ID');
  if (fromSecret) {
    return fromSecret;
  }

  if (!patient.managingOrganization) {
    throw new Error(
      'Cannot create the patient in Metriport: set the METRIPORT_FACILITY_ID secret, or give the patient a managing Organization carrying a Metriport facility identifier.'
    );
  }

  const organization: Organization = await medplum.readReference(patient.managingOrganization);
  const facilityId = organization.identifier?.find(
    (id) => id.system === METRIPORT_ORGANIZATION_IDENTIFIER_SYSTEM
  )?.value;

  if (!facilityId) {
    throw new Error(
      `Organization/${organization.id} has no ${METRIPORT_ORGANIZATION_IDENTIFIER_SYSTEM} identifier, and the METRIPORT_FACILITY_ID secret is not set.`
    );
  }

  return facilityId;
}

/**
 * Appends the Metriport identifier, keeping the identifiers the Patient already has.
 *
 * @param medplum - The Medplum client.
 * @param patient - The Medplum Patient.
 * @param metriportPatientId - The Metriport patient ID to store.
 */
async function linkPatient(
  medplum: MedplumClient,
  patient: WithId<Patient>,
  metriportPatientId: string
): Promise<void> {
  const identifier = { system: METRIPORT_PATIENT_IDENTIFIER_SYSTEM, value: metriportPatientId };

  await medplum.patchResource(
    'Patient',
    patient.id,
    patient.identifier
      ? [{ op: 'add', path: '/identifier/-', value: identifier }]
      : [{ op: 'add', path: '/identifier', value: [identifier] }]
  );
}
