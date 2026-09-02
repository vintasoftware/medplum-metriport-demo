// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { getDisplayString } from '@medplum/core';
import type { Bundle, CodeableConcept, Identifier, Period, Reference, Resource } from '@medplum/fhirtypes';

/**
 * How to read one resource, and how to decide whether two are the same record.
 *
 * Where each importable resource type says what it is, when it happened, and who reported it.
 *
 * Network data is FHIR, so every type spells these three things differently: a condition has a
 * `code` and a `recordedDate`, an immunization a `vaccineCode` and an `occurrenceDateTime`, a
 * dispense a `medicationReference` and a `whenHandedOver`. One table holds all of it, so a new type
 * is one entry and nothing else needs to know the difference.
 */

/** Resolves a reference against the bundle or chart it came from. */
export type ReferenceResolver = (reference: string) => Resource | undefined;

/** A resolver for a caller with nothing to resolve against. */
export const NO_REFERENCES: ReferenceResolver = () => undefined;

interface ResourceFields {
  /**
   * Elements that may carry the primary concept, in order of preference. An element holding a
   * `Reference` is followed, and the target's own `code` is used — which is how the networks name a
   * drug at least as often as they inline it.
   */
  readonly code: readonly string[];
  /** Elements that may carry the clinical date, in order. Each may hold a dateTime or a Period. */
  readonly date: readonly string[];
  /** The FHIR search parameter for that date. Most types define `date`; several do not. */
  readonly dateParam: string;
  /** Elements that may name where the record came from, in order. */
  readonly source: readonly string[];
}

const MEDICATION_CODE = ['medicationCodeableConcept', 'medicationReference'] as const;

/**
 * The importable types. A category may only name a type listed here, which the compiler enforces
 * through {@link ImportableResourceType}, so a new category cannot be added without saying where
 * its code and date live.
 */
const RESOURCE_FIELDS = {
  Condition: {
    code: ['code'],
    date: ['recordedDate', 'onsetDateTime', 'onsetPeriod'],
    dateParam: 'recorded-date',
    source: ['recorder', 'asserter'],
  },
  AllergyIntolerance: {
    code: ['code'],
    date: ['recordedDate', 'onsetDateTime', 'onsetPeriod'],
    dateParam: 'date',
    source: ['recorder', 'asserter'],
  },
  Immunization: {
    code: ['vaccineCode'],
    date: ['occurrenceDateTime'],
    dateParam: 'date',
    source: ['performer', 'manufacturer'],
  },
  MedicationRequest: {
    code: MEDICATION_CODE,
    date: ['authoredOn'],
    dateParam: 'authoredon',
    source: ['requester', 'performer'],
  },
  MedicationStatement: {
    code: MEDICATION_CODE,
    date: ['effectiveDateTime', 'effectivePeriod'],
    dateParam: 'effective',
    source: ['informationSource'],
  },
  MedicationDispense: {
    code: MEDICATION_CODE,
    date: ['whenHandedOver', 'whenPrepared'],
    dateParam: 'whenhandedover',
    source: ['performer'],
  },
  MedicationAdministration: {
    code: MEDICATION_CODE,
    date: ['effectiveDateTime', 'effectivePeriod'],
    dateParam: 'effective-time',
    source: ['performer'],
  },
} as const satisfies Record<string, ResourceFields>;

/** A resource type this panel can list and import. */
export type ImportableResourceType = keyof typeof RESOURCE_FIELDS;

function fieldsFor(resource: Resource): ResourceFields | undefined {
  return RESOURCE_FIELDS[resource.resourceType as ImportableResourceType];
}

/**
 * The FHIR search parameter carrying the clinical date of a type, for a conditional create.
 *
 * @param resourceType - The resource type.
 * @returns The parameter name, or undefined for a type this panel does not import.
 */
function getDateSearchParam(resourceType: string): string | undefined {
  return RESOURCE_FIELDS[resourceType as ImportableResourceType]?.dateParam;
}

/**
 * The concept that says what a record is about.
 *
 * A drug is the awkward one: the networks name it through `medicationReference`, pointing at a
 * `Medication` in the same bundle, at least as often as they inline a `medicationCodeableConcept`.
 * Both are followed, so a caller never has to know which arrived.
 *
 * @param resource - The resource to read.
 * @param resolve - Resolves a reference, for a drug named by one.
 * @returns The concept, or undefined when the resource carries none.
 */
export function getPrimaryCode(resource: Resource, resolve: ReferenceResolver): CodeableConcept | undefined {
  for (const element of fieldsFor(resource)?.code ?? []) {
    const value = readElement(resource, element);
    const concept = isReference(value) ? readCodeOfTarget(value, resolve) : (value as CodeableConcept | undefined);
    if (concept?.coding?.length || concept?.text) {
      return concept;
    }
  }
  return undefined;
}

function readCodeOfTarget(reference: Reference, resolve: ReferenceResolver): CodeableConcept | undefined {
  const target = reference.reference ? resolve(reference.reference) : undefined;
  return target ? (readElement(target, 'code') as CodeableConcept | undefined) : undefined;
}

/**
 * The primary code as a search token, `system|code` where there is a system.
 *
 * @param concept - The concept to read.
 * @returns The token, the concept text as a fallback, or undefined.
 */
function getCodeToken(concept: CodeableConcept | undefined): string | undefined {
  const coding = concept?.coding?.find((c) => c.code);
  if (!coding?.code) {
    return concept?.text;
  }
  return coding.system ? `${coding.system}|${coding.code}` : coding.code;
}

/**
 * The clinically relevant date of a record.
 *
 * @param resource - The resource to read.
 * @returns The date as `YYYY-MM-DD`, or undefined when the resource has none.
 */
export function getResourceDate(resource: Resource): string | undefined {
  for (const element of fieldsFor(resource)?.date ?? []) {
    const value = readElement(resource, element);
    // Network data carries a period as often as an instant, so an element may hold either.
    const date = typeof value === 'string' ? value : getPeriodStart(value as Period | undefined);
    if (date) {
      return date.substring(0, 10);
    }
  }
  return undefined;
}

function getPeriodStart(period: Period | undefined): string | undefined {
  return period?.start ?? period?.end;
}

/**
 * Who reported a record, for the Source column.
 *
 * The networks reference the organization without naming it more often than not, and Metriport
 * hydrates that organization into the same bundle, so an unnamed reference is followed rather than
 * left as an empty column.
 *
 * @param resource - The resource to read.
 * @param resolve - Resolves a reference against the bundle it came from.
 * @returns A display name, or undefined.
 */
export function getResourceSource(resource: Resource, resolve: ReferenceResolver): string | undefined {
  for (const element of fieldsFor(resource)?.source ?? []) {
    const value = readElement(resource, element);
    // A performer is a BackboneElement carrying its reference in `actor`; the rest are references.
    const first = Array.isArray(value) ? value[0] : value;
    const reference = (first as { actor?: Reference } | undefined)?.actor ?? (first as Reference | undefined);
    if (reference?.display) {
      return reference.display;
    }
    const target = reference?.reference ? resolve(reference.reference) : undefined;
    if (target) {
      return getDisplayString(target);
    }
  }
  return undefined;
}

/**
 * What a row says in the Item column.
 *
 * `getDisplayString` falls back to `ResourceType/id` for anything it cannot name, which is most
 * network data: an unreadable row that also cannot be told apart from its neighbours. The concept
 * text comes first, then a coding display, then the code itself.
 *
 * @param resource - The resource to name.
 * @param resolve - Resolves a reference, for a drug named by one.
 * @returns A line a person can read.
 */
export function getRowLabel(resource: Resource, resolve: ReferenceResolver): string {
  const concept = getPrimaryCode(resource, resolve);
  const named =
    concept?.text ?? concept?.coding?.find((c) => c.display)?.display ?? concept?.coding?.find((c) => c.code)?.code;
  if (named) {
    return named;
  }

  const display = getDisplayString(resource);
  // `Type/id` is the giveaway that nothing was found. A type name at least reads as a record.
  return display.startsWith(`${resource.resourceType}/`) ? humanizeResourceType(resource.resourceType) : display;
}

/**
 * Patient-friendly name for a resource type, shown when a category holds more than one so a
 * reported medication is not mistaken for a prescribed one.
 *
 * @param resourceType - The FHIR resource type.
 * @returns The label.
 */
export function humanizeResourceType(resourceType: string): string {
  return RESOURCE_TYPE_LABELS[resourceType] ?? resourceType.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  MedicationAdministration: 'Administered',
  MedicationDispense: 'Dispensed',
  MedicationRequest: 'Prescribed',
  MedicationStatement: 'Reported',
};

function readElement(resource: Resource, element: string): unknown {
  return (resource as unknown as Record<string, unknown>)[element];
}

function isReference(value: unknown): value is Reference {
  return !!value && typeof value === 'object' && 'reference' in (value as object);
}

/**
 * Identity of a record, used for two things that must never disagree: the "In chart" badge, and the
 * conditional-create guard on the import.
 *
 * An identifier wins when there is one. Otherwise it is the primary code plus the date.
 *
 * @param resource - A record from Metriport, or one already in the chart.
 * @param resolve - Resolves a reference, for a drug named by one.
 * @returns A stable comparison key.
 */
export function getImportKey(resource: Resource, resolve: ReferenceResolver): string {
  const identifier = getIdentifierToken(resource);
  if (identifier) {
    return identifier;
  }
  const code = getCodeToken(getPrimaryCode(resource, resolve));
  return `${resource.resourceType}|${code ?? ''}|${getResourceDate(resource) ?? ''}`;
}

/**
 * The conditional-create guard for a clinical record, so importing the same one twice writes
 * nothing the second time.
 *
 * Matched inside the patient's own records: on its identifier when it has one, otherwise on its
 * primary code and the date parameter its type defines.
 *
 * @param resource - The record being imported.
 * @param patientId - The Medplum Patient the record belongs to.
 * @param resolve - Resolves a reference, for a drug named by one.
 * @returns The `ifNoneExist` search, or undefined when nothing identifies the record.
 */
export function getImportIfNoneExist(
  resource: Resource,
  patientId: string,
  resolve: ReferenceResolver
): string | undefined {
  const params = [`patient=Patient/${patientId}`];

  const identifier = getIdentifierToken(resource);
  if (identifier) {
    params.push(`identifier=${identifier}`);
    return params.join('&');
  }

  const code = getCodeToken(getPrimaryCode(resource, resolve));
  if (!code) {
    return undefined;
  }
  params.push(`code=${code}`);

  const date = getResourceDate(resource);
  const dateParam = getDateSearchParam(resource.resourceType);
  if (date && dateParam) {
    params.push(`${dateParam}=${date}`);
  }
  return params.join('&');
}

/**
 * The guard for a support resource — a practitioner, an organization, a medication. It has no
 * patient, so its identifier is all there is to match on, and it goes unguarded without one.
 *
 * @param resource - The support resource being imported.
 * @returns The `ifNoneExist` search, or undefined.
 */
export function getSupportIfNoneExist(resource: Resource): string | undefined {
  const identifier = getIdentifierToken(resource);
  return identifier ? `identifier=${identifier}` : undefined;
}

/**
 * The first identifier carrying a value, as a search token.
 *
 * @param resource - The resource to read.
 * @returns `system|value`, or `value` alone, or undefined.
 */
function getIdentifierToken(resource: Resource): string | undefined {
  const identifiers = (resource as Resource & { identifier?: Identifier[] }).identifier;
  const identifier = identifiers?.find((id) => id.value);
  if (!identifier?.value) {
    return undefined;
  }
  return identifier.system ? `${identifier.system}|${identifier.value}` : identifier.value;
}

/**
 * Indexes a bundle by every reference string that can reach an entry: its `fullUrl` and its
 * `ResourceType/id`. Metriport uses both, depending on where the resource came from.
 *
 * @param bundle - The bundle to index.
 * @returns The index.
 */
export function indexBundleByReference(bundle: Bundle): Map<string, Resource> {
  const index = new Map<string, Resource>();
  for (const entry of bundle.entry ?? []) {
    const resource = entry.resource;
    if (!resource) {
      continue;
    }
    if (entry.fullUrl) {
      index.set(entry.fullUrl, resource);
    }
    if (resource.id) {
      index.set(`${resource.resourceType}/${resource.id}`, resource);
    }
  }
  return index;
}

/**
 * A resolver over one bundle.
 *
 * @param bundle - The bundle to resolve against.
 * @returns The resolver.
 */
export function createBundleResolver(bundle: Bundle): ReferenceResolver {
  const index = indexBundleByReference(bundle);
  return (reference) => index.get(reference);
}
