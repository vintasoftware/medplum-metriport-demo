// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Bundle, Condition, Resource } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { createBundleResolver, getImportKey } from './MetriportImportPanel.fields';
import { buildImportRows, getDateFrom } from './MetriportImportPanel.utils';

const SNOMED = 'http://snomed.info/sct';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';

const condition: Condition = {
  resourceType: 'Condition',
  id: 'cond-1',
  subject: { reference: 'Patient/metriport-1' },
  recordedDate: '2025-03-30T08:00:00Z',
  recorder: { reference: 'Practitioner/prac-1', display: 'Dr Grey' },
  code: { text: 'Asthma', coding: [{ system: SNOMED, code: '195967001' }] },
};

const medication = {
  resourceType: 'Medication',
  id: 'med-1',
  code: { text: 'Metformin 500 MG oral tablet', coding: [{ system: RXNORM, code: '860975' }] },
};

/**
 * A medication record that names its drug by reference, the way network data usually does.
 *
 * @param id - The resource id.
 * @param authoredOn - The date it carries.
 * @returns The request.
 */
function medicationRequest(id: string, authoredOn: string): Resource {
  return {
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    subject: { reference: 'Patient/metriport-1' },
    authoredOn,
    medicationReference: { reference: 'Medication/med-1' },
  } as Resource;
}

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

describe('buildImportRows', () => {
  test('Marks a row already in the chart and sorts newest first', () => {
    const newer: Condition = { ...condition, id: 'cond-3', recordedDate: '2026-01-01' };
    const bundle = bundleOf(condition, newer);
    const rows = buildImportRows({
      resources: [condition, newer],
      bundle,
      chartKeys: new Set([getImportKey(condition, createBundleResolver(bundle))]),
      patientId: 'local-1',
    });

    expect(rows.map((row) => row.date)).toStrictEqual(['2026-01-01', '2025-03-30']);
    expect(rows[0].inChart).toBe(false);
    expect(rows[1].inChart).toBe(true);
    expect(rows[1].source).toBe('Dr Grey');
  });

  test('Carries the guard, so the import does not have to work it out again', () => {
    const bundle = bundleOf(medication, medicationRequest('mr-1', '2021-01-22'));
    const [row] = buildImportRows({
      resources: [medicationRequest('mr-1', '2021-01-22')],
      bundle,
      chartKeys: new Set(),
      patientId: 'local-1',
    });

    expect(row.label).toBe('Metformin 500 MG oral tablet');
    expect(row.ifNoneExist).toBe(`patient=Patient/local-1&code=${RXNORM}|860975&authoredon=2021-01-22`);
  });

  test('Keeps one row per record, however alike the records are', () => {
    const resources = [medicationRequest('mr-1', '2021-01-22'), medicationRequest('mr-2', '2021-01-22')];
    const bundle = bundleOf(medication, ...resources);
    const rows = buildImportRows({ resources, bundle, chartKeys: new Set(), patientId: 'local-1' });

    expect(rows).toHaveLength(2);
    // Same drug, same date, no identifier: one match key, but two records and two checkboxes.
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(new Set(rows.map((row) => row.ifNoneExist)).size).toBe(1);
  });

  test('Works without a bundle, and then cannot resolve a drug named by reference', () => {
    const rows = buildImportRows({
      resources: [medicationRequest('mr-1', '2021-01-22')],
      chartKeys: new Set(),
      patientId: 'local-1',
    });

    expect(rows[0].label).toBe('Prescribed');
  });
});

describe('getDateFrom', () => {
  test('Returns undefined for all time', () => {
    expect(getDateFrom('all')).toBeUndefined();
  });

  test('Returns an ISO date for a number of years', () => {
    expect(getDateFrom('3')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
