// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Reference, Resource } from '@medplum/fhirtypes';
import type { ImportableResourceType, ReferenceResolver } from './MetriportImportPanel.fields';
import {
  createBundleResolver,
  getImportIfNoneExist,
  getImportKey,
  getResourceDate,
  getResourceSource,
  getRowLabel,
} from './MetriportImportPanel.fields';

/**
 * What the import panel shows: which categories there are, which dates they cover, and one row per
 * record with everything the table and the import need.
 */

/** A group of resource types the provider reviews under one heading. */
export interface MetriportImportCategory {
  /** Stable value carried in the URL. */
  readonly id: string;
  /** Plural heading, e.g. "Problems". */
  readonly label: string;
  /**
   * Every resource type shown under the heading. A clinical heading rarely maps to one FHIR type:
   * medications arrive from the networks as requests, statements, dispenses and administrations.
   */
  readonly resourceTypes: readonly ImportableResourceType[];
}

/**
 * The categories the MVP imports.
 *
 * Each one has somewhere to land in this chart: the Allergies, Problems, Medications and
 * Immunizations sections of the patient summary. Metriport returns more than this — procedures, lab
 * reports, documents, observations, encounters, coverage — and those were dropped rather than
 * shipped half-working. A Procedure imports into no view this app has. A DiagnosticReport arrives
 * without the Observations that are its content. A DocumentReference arrives with a Metriport URL
 * the browser has no key for. Each needs work of its own before it belongs here.
 */
export const METRIPORT_IMPORT_CATEGORIES: readonly MetriportImportCategory[] = [
  // "Problems" is what the chart calls them, in the patient summary and on the intake form. The
  // FHIR type is still Condition.
  { id: 'problems', label: 'Problems', resourceTypes: ['Condition'] },
  { id: 'allergies', label: 'Allergies', resourceTypes: ['AllergyIntolerance'] },
  {
    id: 'medications',
    label: 'Medications',
    resourceTypes: ['MedicationRequest', 'MedicationStatement', 'MedicationDispense', 'MedicationAdministration'],
  },
  { id: 'immunizations', label: 'Immunizations', resourceTypes: ['Immunization'] },
];

/**
 * How many rows may be listed at once. Above this the category asks for a narrower date range
 * instead of fetching, which the count endpoint lets us decide before paying for the fetch. Matches
 * MAX_FETCH_ENTRIES in bots/src/metriportConsolidated.ts, which refuses the fetch anyway.
 */
export const MAX_REVIEW_ROWS = 500;

/** Date range choices. The value is a number of years, or `all`. */
export const DATE_RANGE_OPTIONS = [
  { value: '1', label: 'Last year' },
  { value: '3', label: 'Last 3 years' },
  { value: '5', label: 'Last 5 years' },
  { value: 'all', label: 'All time' },
];

/**
 * All time. The Metriport patient view shows a patient's whole history, and network data is often
 * years old, so any narrower default would disagree with it on sight.
 */
export const DEFAULT_DATE_RANGE = 'all';

/**
 * Turns a date range choice into the `dateFrom` the Metriport consolidated endpoints accept.
 *
 * @param range - A value from {@link DATE_RANGE_OPTIONS}.
 * @returns The inclusive start date as `YYYY-MM-DD`, or undefined for all time.
 */
export function getDateFrom(range: string): string | undefined {
  const years = Number.parseInt(range, 10);
  if (Number.isNaN(years)) {
    return undefined;
  }
  const from = new Date();
  from.setFullYear(from.getFullYear() - years);
  return from.toISOString().substring(0, 10);
}

/** One reviewable record in the table. */
export interface MetriportImportRow {
  /**
   * Identity of the row, unique per record. This is not the match key: two records can be
   * indistinguishable to a matcher and still be two records, and each keeps its own line and its
   * own checkbox.
   */
  readonly key: string;
  /** The record as Metriport returned it. Imported unchanged. */
  readonly resource: Resource;
  readonly label: string;
  readonly date?: string;
  readonly source?: string;
  /** True when a record matching this one is already in the chart. */
  readonly inChart: boolean;
  /**
   * The conditional-create guard for the import. Computed here rather than at import time, because
   * this is where a drug named by reference can still be resolved against its bundle.
   */
  readonly ifNoneExist?: string;
}

export interface BuildImportRowsParams {
  /** The records Metriport returned for the category. */
  readonly resources: Resource[];
  /** The bundle they came from, for the medications and organizations they name. */
  readonly bundle?: Bundle;
  /** Keys of what the chart already holds, from {@link loadChartKeys}. */
  readonly chartKeys: Set<string>;
  /** The Medplum Patient the records would be imported into. */
  readonly patientId: string;
}

/**
 * Builds the review rows for one category, most recent first. One row per record, always: whatever
 * Metriport returned is what the provider sees and chooses from.
 *
 * @param params - Records, their bundle, the chart keys and the patient.
 * @returns The rows to render.
 */
export function buildImportRows(params: BuildImportRowsParams): MetriportImportRow[] {
  const { resources, bundle, chartKeys, patientId } = params;
  const resolve = bundle ? createBundleResolver(bundle) : createResolver([]);

  return resources
    .map((resource, position) => ({
      // The resource id is unique within a bundle; the position covers a resource without one.
      key: resource.id ? `${resource.resourceType}/${resource.id}` : `${resource.resourceType}#${position}`,
      resource,
      label: getRowLabel(resource, resolve),
      date: getResourceDate(resource),
      source: getResourceSource(resource, resolve),
      inChart: chartKeys.has(getImportKey(resource, resolve)),
      ifNoneExist: getImportIfNoneExist(resource, patientId, resolve),
    }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.label.localeCompare(b.label));
}

/** How much of the chart is read to mark rows. See {@link loadChartKeys}. */
const CHART_SEARCH_COUNT = 1000;

/**
 * Reads the chart and returns the match key of every record of these types it already holds.
 *
 * Only the first page is read. A chart holding more than {@link CHART_SEARCH_COUNT} records of one
 * type may therefore show a row as missing when it is not. The badge is a hint; the conditional
 * create on the import is what actually prevents a duplicate.
 *
 * @param medplum - The Medplum client.
 * @param resourceTypes - The resource types to read, normally one category's worth.
 * @param patientId - The Medplum Patient ID whose chart is open.
 * @returns The match keys already in the chart.
 */
export async function loadChartKeys(
  medplum: MedplumClient,
  resourceTypes: readonly ImportableResourceType[],
  patientId: string
): Promise<Set<string>> {
  const pages = await Promise.all(
    resourceTypes.map((resourceType) =>
      medplum.searchResources(resourceType, {
        patient: `Patient/${patientId}`,
        _count: CHART_SEARCH_COUNT,
      })
    )
  );
  const existing: Resource[] = pages.flat();
  const resolve = createResolver(await loadReferencedMedications(medplum, existing));
  return new Set(existing.map((resource) => getImportKey(resource, resolve)));
}

/**
 * Reads the `Medication` resources the chart's medication records point at.
 *
 * A medication record names its drug by reference as often as it inlines the code, and an import
 * carries that `Medication` into the chart with it. Without reading them back, a drug already in the
 * chart has no code to compare and every row shows as missing.
 *
 * @param medplum - The Medplum client.
 * @param resources - The chart records just read.
 * @returns The referenced medications, empty when there are none.
 */
async function loadReferencedMedications(medplum: MedplumClient, resources: Resource[]): Promise<Resource[]> {
  const ids = new Set<string>();
  for (const resource of resources) {
    const reference = (resource as Resource & { medicationReference?: Reference }).medicationReference?.reference;
    if (reference?.startsWith('Medication/')) {
      ids.add(reference.slice('Medication/'.length));
    }
  }
  if (ids.size === 0) {
    return [];
  }

  // One search rather than one read per record: `_id` accepts a comma-separated list.
  return medplum.searchResources('Medication', {
    _id: [...ids].join(','),
    _count: CHART_SEARCH_COUNT,
  });
}

/**
 * A resolver over a flat list of resources, addressed as `ResourceType/id`.
 *
 * @param resources - The resources to resolve against.
 * @returns The resolver.
 */
function createResolver(resources: Resource[]): ReferenceResolver {
  const index = new Map(resources.map((resource) => [`${resource.resourceType}/${resource.id}`, resource]));
  return (reference) => index.get(reference);
}
