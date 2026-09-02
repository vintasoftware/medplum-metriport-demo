// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Bundle, Condition, Practitioner, Resource } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { ImportRecord } from './MetriportImportPanel.bundle';
import { buildMetriportImportBundle } from './MetriportImportPanel.bundle';

const SNOMED = 'http://snomed.info/sct';

const patient = { resourceType: 'Patient', id: 'metriport-1' } as Resource;

const condition: Condition = {
  resourceType: 'Condition',
  id: 'cond-1',
  subject: { reference: 'Patient/metriport-1' },
  recordedDate: '2025-03-30',
  recorder: { reference: 'Practitioner/prac-1', display: 'Dr Grey' },
  code: { text: 'Asthma', coding: [{ system: SNOMED, code: '195967001' }] },
};

const other: Condition = {
  resourceType: 'Condition',
  id: 'cond-2',
  subject: { reference: 'Patient/metriport-1' },
  recordedDate: '2024-01-01',
  code: { coding: [{ system: SNOMED, code: '38341003' }] },
};

const practitioner: Practitioner = {
  resourceType: 'Practitioner',
  id: 'prac-1',
  identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567893' }],
  name: [{ family: 'Grey' }],
};

function bundleOf(...resources: object[]): Bundle {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    entry: resources.map((resource) => ({
      fullUrl: `urn:uuid:${(resource as { id: string }).id}`,
      resource: resource as never,
    })),
  };
}

function ticked(...resources: Resource[]): ImportRecord[] {
  return resources.map((resource) => ({ resource, ifNoneExist: `id=${resource.id}` }));
}

describe('buildMetriportImportBundle', () => {
  test('Imports only the ticked record', () => {
    const transaction = buildMetriportImportBundle(bundleOf(patient, condition, other), ticked(condition), 'local-1');

    expect(transaction.type).toBe('transaction');
    expect(transaction.entry?.map((entry) => entry.resource?.id)).toStrictEqual(['cond-1']);
  });

  test('Never imports the Metriport patient, even when it is passed in', () => {
    const transaction = buildMetriportImportBundle(bundleOf(patient, condition), ticked(patient, condition), 'local-1');

    expect(transaction.entry?.some((entry) => entry.resource?.resourceType === 'Patient')).toBe(false);
  });

  test('Repoints the patient reference at the chart patient', () => {
    const transaction = buildMetriportImportBundle(bundleOf(patient, condition), ticked(condition), 'local-1');
    const imported = transaction.entry?.[0]?.resource as Condition;

    expect(imported.subject?.reference).toBe('Patient/local-1');
  });

  test('Carries the guard the row worked out, rather than deriving its own', () => {
    const transaction = buildMetriportImportBundle(bundleOf(patient, condition), ticked(condition), 'local-1');

    expect(transaction.entry?.[0]?.request?.method).toBe('POST');
    expect(transaction.entry?.[0]?.request?.ifNoneExist).toBe('id=cond-1');
  });

  test('Pulls in a referenced support resource, points at it, and guards it on its identifier', () => {
    const transaction = buildMetriportImportBundle(
      bundleOf(patient, condition, practitioner),
      ticked(condition),
      'local-1'
    );

    expect(transaction.entry).toHaveLength(2);
    const practitionerEntry = transaction.entry?.find((entry) => entry.resource?.resourceType === 'Practitioner');
    const imported = transaction.entry?.[0]?.resource as Condition;
    expect(imported.recorder?.reference).toBe(practitionerEntry?.fullUrl);
    expect(practitionerEntry?.request?.ifNoneExist).toBe('identifier=http://hl7.org/fhir/sid/us-npi|1234567893');
  });

  test('Never pulls in a clinical record the provider did not tick', () => {
    const referencing: Condition = { ...condition, evidence: [{ detail: [{ reference: 'Condition/cond-2' }] }] };
    const transaction = buildMetriportImportBundle(
      bundleOf(patient, referencing, other),
      ticked(referencing),
      'local-1'
    );

    expect(transaction.entry).toHaveLength(1);
  });

  test('Drops a reference to something outside the transaction, and keeps its display', () => {
    const transaction = buildMetriportImportBundle(bundleOf(patient, condition), ticked(condition), 'local-1');
    const imported = transaction.entry?.[0]?.resource as Condition;

    expect(imported.recorder?.reference).toBeUndefined();
    expect(imported.recorder?.display).toBe('Dr Grey');
  });

  test('Leaves the record it was given untouched', () => {
    buildMetriportImportBundle(bundleOf(patient, condition), ticked(condition), 'local-1');

    expect(condition.subject?.reference).toBe('Patient/metriport-1');
    expect(condition.recorder?.reference).toBe('Practitioner/prac-1');
  });

  test('Returns no entries when nothing was ticked', () => {
    expect(buildMetriportImportBundle(bundleOf(patient, condition), [], 'local-1').entry).toStrictEqual([]);
  });
});
