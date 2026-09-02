// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';
import type { MetriportConfig } from './shared/metriport';
import {
  getMetriportConfig,
  getMetriportPatientId,
  metriportRequest,
  requirePractitioner,
  writeMetriportAuditEvent,
} from './shared/metriport';

/**
 * Reads a linked patient's consolidated data from Metriport, so the chart can offer it for import.
 *
 * Two actions, one per Metriport endpoint. Both are synchronous and both read the cached result of
 * the network query that `metriport-link-patient` starts, so no webhook is involved:
 *
 * - `count` returns the number of records per resource type. The chart uses it to decide what may
 *   be listed, before any record is fetched.
 * - `fetch` returns the records of the requested types as a FHIR Bundle.
 *
 * Both report on the same set of records, already merged where several sources sent the same one, so
 * the two normally agree. A count can still come out slightly higher than the records that follow.
 *
 * Both can be slow. Metriport prepares a patient's consolidated data on the first read after a
 * network query, which takes far longer than any bot may run, so this bot needs a raised
 * `Bot.timeout` and the caller needs to offer a retry. A later read succeeds, because the first
 * attempt started that work.
 *
 * Nothing is written to the chart here. The caller reviews the records and imports the ones it
 * wants with its own credentials, so the project AccessPolicy governs what enters the chart.
 *
 * Input: `{ patientId, action, resourceTypes?, dateFrom?, dateTo? }`
 *
 * https://docs.metriport.com/medical-api/api-reference/fhir/consolidated-data-count
 * https://docs.metriport.com/medical-api/api-reference/fhir/consolidated-data-query-post
 */

/**
 * The resource types this bot will read. The browser names the types it wants, so the list is
 * enforced here rather than trusted: a caller cannot widen the disclosure by asking for more.
 *
 * These are the types the chart can show and import today. Metriport holds more — procedures,
 * reports, documents, observations — and each needs work in the app before it is worth disclosing.
 */
const ALLOWED_RESOURCE_TYPES = [
  'AllergyIntolerance',
  'Condition',
  'Immunization',
  'MedicationAdministration',
  'MedicationDispense',
  'MedicationRequest',
  'MedicationStatement',
] as const;

/**
 * Above this, a fetch is refused and the caller is told the count instead. A consolidated bundle
 * for a wide date range runs to thousands of records, which is more than a review list can use and
 * more than a bot response should carry. The chart uses the same number to decide which categories
 * it will open at all — see MAX_REVIEW_ROWS in MetriportImportPanel.utils.ts.
 */
const MAX_FETCH_ENTRIES = 500;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface DateRange {
  /** Inclusive start date, `YYYY-MM-DD`. */
  dateFrom?: string;
  /** Inclusive end date, `YYYY-MM-DD`. */
  dateTo?: string;
}

/**
 * Counting takes no resource types: the count response carries every type regardless, and asking for
 * a subset only makes the call slower. Reading records takes the types to read.
 */
export type MetriportConsolidatedInput =
  | ({ patientId: string; action: 'count' } & DateRange)
  | ({ patientId: string; action: 'fetch'; resourceTypes: string[] } & DateRange);

export type MetriportConsolidatedOutput =
  /** The patient has no Metriport identifier, so there is nothing to read. */
  | { status: 'not-linked' }
  | { status: 'counts'; resources: Record<string, number> }
  | { status: 'bundle'; bundle: Bundle }
  /** Too many records to return. The caller narrows the date range and asks again. */
  | { status: 'too-many'; count: number; limit: number };

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<MetriportConsolidatedInput>
): Promise<MetriportConsolidatedOutput> {
  const input = event.input;
  const patientId = input?.patientId;
  const action = input?.action;
  if (!patientId) {
    throw new Error('Missing patientId');
  }
  if (action !== 'count' && action !== 'fetch') {
    throw new Error('action must be "count" or "fetch"');
  }
  const { dateFrom, dateTo } = input;

  requirePractitioner(event, 'read Metriport data for a patient');

  const patient = await medplum.readResource('Patient', patientId);
  const metriportPatientId = getMetriportPatientId(patient);
  if (!metriportPatientId) {
    return { status: 'not-linked' };
  }

  const config = getMetriportConfig(event);
  const basePath = `/medical/v1/patient/${encodeURIComponent(metriportPatientId)}/consolidated`;

  if (action === 'count') {
    // No `resources` filter on purpose: the response carries every type either way, and filtering
    // measurably slows the call. Dates are passed when asked for, which costs the same. The
    // response is cut down to the allowed types here, so nothing outside the allowlist reaches the
    // caller.
    const counts = await metriportRequest<{ total: number; resources: Record<string, number> }>(
      config,
      `${basePath}/count${buildQuery([], dateFrom, dateTo)}`
    );
    // A count is not a disclosure of records, so it is not audited. Reading them is, below.
    return { status: 'counts', resources: allowedCounts(counts.resources ?? {}) };
  }

  const types = checkResourceTypes(input.resourceTypes);
  const result = await fetchBundle(config, `${basePath}${buildQuery(types, dateFrom, dateTo)}`);
  if (result.status === 'bundle') {
    await writeMetriportAuditEvent(medplum, event, 'record-access', {
      patientId,
      metriportPatientId,
      // Resource types and counts, never the records themselves.
      description: `Metriport consolidated data read: ${types.join(', ')} (${result.bundle.entry?.length ?? 0} entries)`,
    });
  }
  return result;
}

/**
 * Reads the consolidated bundle, and refuses one that is too large to review.
 *
 * @param config - The Metriport configuration.
 * @param path - The consolidated path, query string included.
 * @returns The bundle, or a `too-many` result.
 */
async function fetchBundle(config: MetriportConfig, path: string): Promise<MetriportConsolidatedOutput> {
  const bundle = await metriportRequest<Bundle>(config, path);
  const count = bundle.entry?.length ?? 0;
  if (count > MAX_FETCH_ENTRIES) {
    return { status: 'too-many', count, limit: MAX_FETCH_ENTRIES };
  }
  return { status: 'bundle', bundle };
}

/**
 * Keeps only the counts for types this bot may read.
 *
 * @param counts - The per-type counts Metriport returned, for every type it holds.
 * @returns The counts for the allowed types.
 */
function allowedCounts(counts: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const resourceType of ALLOWED_RESOURCE_TYPES) {
    const count = counts[resourceType];
    if (count) {
      result[resourceType] = count;
    }
  }
  return result;
}

/**
 * Keeps only the resource types this bot may read.
 *
 * @param requested - The types the caller asked for.
 * @returns The allowed types, in the order given.
 * @throws When no type is requested, or one is not allowed, so a mistake is visible not silent.
 */
function checkResourceTypes(requested: string[] | undefined): string[] {
  if (!requested?.length) {
    throw new Error('fetch requires at least one resource type');
  }
  const rejected = requested.filter((type) => !ALLOWED_RESOURCE_TYPES.includes(type as never));
  if (rejected.length > 0) {
    throw new Error(`Not allowed to read from Metriport: ${rejected.join(', ')}`);
  }
  return requested;
}

/**
 * Builds the query string shared by both endpoints.
 *
 * @param types - Resource types to read. Omitted from the query when empty, which means all.
 * @param dateFrom - Inclusive start date.
 * @param dateTo - Inclusive end date.
 * @returns The query string, leading `?` included, or an empty string.
 */
function buildQuery(types: string[], dateFrom: string | undefined, dateTo: string | undefined): string {
  const params = new URLSearchParams();
  if (types.length > 0) {
    params.set('resources', types.join(','));
  }
  if (dateFrom) {
    params.set('dateFrom', checkDate(dateFrom, 'dateFrom'));
  }
  if (dateTo) {
    params.set('dateTo', checkDate(dateTo, 'dateTo'));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function checkDate(value: string, name: string): string {
  if (!ISO_DATE.test(value)) {
    throw new Error(`${name} must be formatted YYYY-MM-DD`);
  }
  return value;
}
