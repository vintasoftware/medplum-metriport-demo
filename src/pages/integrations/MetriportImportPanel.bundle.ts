// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { getSupportIfNoneExist, indexBundleByReference } from './MetriportImportPanel.fields';

/**
 * Turning the records a provider ticked into one FHIR transaction.
 *
 * The transaction is sent with the provider's own credentials, so the project AccessPolicy decides
 * what may enter the chart and Medplum audits the writes.
 */

/**
 * One record to import, with the guard that stops it being written twice.
 *
 * The guard is computed where the record was read, because that is the only place a drug named by
 * reference can be resolved. Passing it in rather than deriving it here keeps one answer for both
 * the "In chart" badge and the write.
 */
export interface ImportRecord {
  readonly resource: Resource;
  readonly ifNoneExist?: string;
}

/**
 * Types imported as context for a ticked record, never listed as rows of their own: the practitioner
 * who recorded it, the organization it came from, the medication it names. Metriport hydrates these
 * into every filtered bundle, so a ticked record does not arrive with references that point at
 * nothing.
 *
 * Encounter is deliberately absent. It would appear in the chart as a visit that nobody booked.
 */
const SUPPORT_RESOURCE_TYPES = new Set([
  'Device',
  'Location',
  'Medication',
  'Organization',
  'Practitioner',
  'PractitionerRole',
  'Specimen',
  'Substance',
]);

/**
 * Builds the transaction that imports the ticked records into the chart.
 *
 * Three things happen here, and each one matters:
 *
 *  1. Only the ticked records are imported, plus the support resources they reference. A clinical
 *     record the provider did not tick is never pulled in by a reference.
 *  2. Every reference is repointed. The Metriport patient becomes the chart patient, a reference
 *     into the transaction becomes its `urn:uuid`, and a reference to anything else loses its
 *     pointer but keeps its display, so no record arrives pointing at a resource that is not there.
 *  3. Every entry is a conditional create, so importing the same record twice creates nothing the
 *     second time.
 *
 * @param bundle - The bundle the Metriport bot returned, for the resources a record references.
 * @param records - The records to import, from the ticked rows.
 * @param patientId - The Medplum Patient the records belong to.
 * @returns A transaction bundle, with no entries when nothing was ticked.
 */
export function buildMetriportImportBundle(bundle: Bundle, records: ImportRecord[], patientId: string): Bundle {
  const index = indexBundleByReference(bundle);
  const patientRefs = collectPatientRefs(index);

  const clinical = records.filter((record) => record.resource.resourceType !== 'Patient');
  const included = withSupportResources(clinical, index);

  const uuids = new Map<Resource, string>();
  for (const record of included) {
    uuids.set(record.resource, `urn:uuid:${crypto.randomUUID()}`);
  }

  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: included.map((record) => ({
      fullUrl: uuids.get(record.resource),
      resource: repointReferences(record.resource, { index, uuids, patientRefs, patientId }),
      request: {
        method: 'POST' as const,
        url: record.resource.resourceType,
        ifNoneExist: record.ifNoneExist,
      },
    })),
  };
}

function collectPatientRefs(index: Map<string, Resource>): Set<string> {
  const refs = new Set<string>();
  for (const [reference, resource] of index) {
    if (resource.resourceType === 'Patient') {
      refs.add(reference);
    }
  }
  return refs;
}

/**
 * Adds the support resources the ticked records reference, and the ones those reference in turn.
 * A support resource is matched on its identifier alone, since it has no patient.
 *
 * @param records - The records the provider ticked.
 * @param index - Every resource in the bundle, by reference string.
 * @returns The ticked records followed by their support resources, without duplicates.
 */
function withSupportResources(records: ImportRecord[], index: Map<string, Resource>): ImportRecord[] {
  const included = [...records];
  const seen = new Set<Resource>(records.map((record) => record.resource));
  const queue = [...seen];

  while (queue.length > 0) {
    const resource = queue.shift() as Resource;
    for (const reference of findReferences(resource)) {
      const target = index.get(reference);
      if (target && !seen.has(target) && SUPPORT_RESOURCE_TYPES.has(target.resourceType)) {
        seen.add(target);
        included.push({ resource: target, ifNoneExist: getSupportIfNoneExist(target) });
        queue.push(target);
      }
    }
  }
  return included;
}

function findReferences(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== 'object') {
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      findReferences(item, found);
    }
    return found;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.reference === 'string') {
    found.push(record.reference);
  }
  for (const key of Object.keys(record)) {
    if (key !== 'reference') {
      findReferences(record[key], found);
    }
  }
  return found;
}

interface RepointContext {
  readonly index: Map<string, Resource>;
  readonly uuids: Map<Resource, string>;
  readonly patientRefs: Set<string>;
  readonly patientId: string;
}

function repointReferences<T extends Resource>(resource: T, context: RepointContext): T {
  const copy = JSON.parse(JSON.stringify(resource)) as T;
  walkReferences(copy, context);
  return copy;
}

function walkReferences(value: unknown, context: RepointContext): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkReferences(item, context);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  const reference = record.reference;
  if (typeof reference === 'string') {
    if (context.patientRefs.has(reference)) {
      record.reference = `Patient/${context.patientId}`;
    } else {
      const uuid = context.uuids.get(context.index.get(reference) as Resource);
      if (uuid) {
        record.reference = uuid;
      } else {
        // Nothing in the transaction to point at. Keep the display, drop the dead pointer.
        delete record.reference;
      }
    }
  }
  for (const key of Object.keys(record)) {
    if (key !== 'reference') {
      walkReferences(record[key], context);
    }
  }
}
