// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Bundle, Condition, Immunization, Practitioner } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import {
  createBundleResolver,
  getImportIfNoneExist,
  getImportKey,
  getResourceDate,
  getResourceSource,
  getRowLabel,
  getSupportIfNoneExist,
  NO_REFERENCES,
} from './MetriportImportPanel.fields';

const SNOMED = 'http://snomed.info/sct';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const CVX = 'http://hl7.org/fhir/sid/cvx';

const condition: Condition = {
  resourceType: 'Condition',
  id: 'cond-1',
  subject: { reference: 'Patient/metriport-1' },
  recordedDate: '2025-03-30T08:00:00Z',
  recorder: { reference: 'Practitioner/prac-1', display: 'Dr Grey' },
  code: { text: 'Asthma', coding: [{ system: SNOMED, code: '195967001' }] },
};

const immunization: Immunization = {
  resourceType: 'Immunization',
  id: 'imm-1',
  status: 'completed',
  patient: { reference: 'Patient/metriport-1' },
  occurrenceDateTime: '2026-09-01',
  vaccineCode: { coding: [{ system: CVX, code: '140' }] },
};

const practitioner: Practitioner = {
  resourceType: 'Practitioner',
  id: 'prac-1',
  identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567893' }],
  name: [{ family: 'Grey' }],
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
function medicationRequest(id: string, authoredOn: string): object {
  return {
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    subject: { reference: 'Patient/metriport-1' },
    authoredOn,
    medicationReference: { reference: 'Medication/med-1' },
  };
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

describe('getImportKey', () => {
  test('Prefers the identifier', () => {
    const withIdentifier = { ...condition, identifier: [{ system: 'urn:oid:1.2.3', value: 'abc' }] };
    expect(getImportKey(withIdentifier, NO_REFERENCES)).toBe('urn:oid:1.2.3|abc');
  });

  test('Falls back to the primary code and the date', () => {
    expect(getImportKey(condition, NO_REFERENCES)).toBe(`Condition|${SNOMED}|195967001|2025-03-30`);
  });

  test('Reads the code from the element the type uses', () => {
    expect(getImportKey(immunization, NO_REFERENCES)).toBe(`Immunization|${CVX}|140|2026-09-01`);
  });

  test('Matches the same record on both sides, so a chart copy is recognised', () => {
    const inChart: Condition = { ...condition, id: 'chart-copy', meta: { versionId: 'v2' } };
    expect(getImportKey(inChart, NO_REFERENCES)).toBe(getImportKey(condition, NO_REFERENCES));
  });

  test('Follows medicationReference, so two drugs on one date are not the same record', () => {
    const bundle = bundleOf(medication, medicationRequest('mr-1', '2021-01-22'));
    const resolve = createBundleResolver(bundle);
    const request = medicationRequest('mr-1', '2021-01-22') as never;

    expect(getImportKey(request, resolve)).toBe(`MedicationRequest|${RXNORM}|860975|2021-01-22`);
    // Without a resolver the drug cannot be named, which is why the resolver is not optional.
    expect(getImportKey(request, NO_REFERENCES)).toBe('MedicationRequest||2021-01-22');
  });
});

describe('getImportIfNoneExist', () => {
  test('Constrains a clinical record to the patient, on its code and date', () => {
    expect(getImportIfNoneExist(condition, 'local-1', NO_REFERENCES)).toBe(
      `patient=Patient/local-1&code=${SNOMED}|195967001&recorded-date=2025-03-30`
    );
  });

  test('Uses the date parameter the type defines', () => {
    expect(getImportIfNoneExist(immunization, 'local-1', NO_REFERENCES)).toBe(
      `patient=Patient/local-1&code=${CVX}|140&date=2026-09-01`
    );
    const bundle = bundleOf(medication, medicationRequest('mr-1', '2021-01-22'));
    expect(
      getImportIfNoneExist(medicationRequest('mr-1', '2021-01-22') as never, 'local-1', createBundleResolver(bundle))
    ).toContain('authoredon=2021-01-22');
  });

  test('Prefers the identifier, still inside the patient', () => {
    const withIdentifier = { ...condition, identifier: [{ value: 'cond-42' }] };
    expect(getImportIfNoneExist(withIdentifier, 'local-1', NO_REFERENCES)).toBe(
      'patient=Patient/local-1&identifier=cond-42'
    );
  });

  test('Follows medicationReference, so a medication is not imported unguarded', () => {
    const bundle = bundleOf(medication, medicationRequest('mr-9', '2021-01-22'));
    expect(
      getImportIfNoneExist(medicationRequest('mr-9', '2021-01-22') as never, 'local-1', createBundleResolver(bundle))
    ).toBe(`patient=Patient/local-1&code=${RXNORM}|860975&authoredon=2021-01-22`);
  });

  test('Leaves a record unguarded when nothing identifies it', () => {
    const bare = { resourceType: 'Condition', subject: {} } as Condition;
    expect(getImportIfNoneExist(bare, 'local-1', NO_REFERENCES)).toBeUndefined();
  });
});

describe('getSupportIfNoneExist', () => {
  test('Matches a support resource on its identifier alone', () => {
    expect(getSupportIfNoneExist(practitioner)).toBe('identifier=http://hl7.org/fhir/sid/us-npi|1234567893');
  });

  test('Leaves it unguarded without one', () => {
    expect(getSupportIfNoneExist({ resourceType: 'Practitioner' })).toBeUndefined();
  });
});

describe('getResourceDate', () => {
  test('Reads a period when the type has no instant to offer', () => {
    const periodOnly = { resourceType: 'Condition', subject: {}, onsetPeriod: { start: '2021-03-04T00:00:00Z' } };
    expect(getResourceDate(periodOnly as Condition)).toBe('2021-03-04');
  });

  test('Returns nothing for a type this panel does not import', () => {
    expect(getResourceDate({ resourceType: 'Procedure', performedDateTime: '2020-01-01' } as never)).toBeUndefined();
  });
});

describe('getResourceSource', () => {
  test('Prefers a display on the reference', () => {
    expect(getResourceSource(condition, NO_REFERENCES)).toBe('Dr Grey');
  });

  test('Resolves an organization the reference names but does not display', () => {
    const referencing = {
      resourceType: 'Condition',
      id: 'c-ref',
      recorder: { reference: 'Organization/org-9' },
    } as Condition;
    const bundle = bundleOf(referencing, { resourceType: 'Organization', id: 'org-9', name: 'Mercy General Hospital' });

    expect(getResourceSource(referencing, createBundleResolver(bundle))).toBe('Mercy General Hospital');
    expect(getResourceSource(referencing, NO_REFERENCES)).toBeUndefined();
  });
});

describe('getRowLabel', () => {
  test('Follows medicationReference, so a row is not a resource id', () => {
    const bundle = bundleOf(medication, medicationRequest('mr-1', '2021-01-22'));
    expect(getRowLabel(medicationRequest('mr-1', '2021-01-22') as never, createBundleResolver(bundle))).toBe(
      'Metformin 500 MG oral tablet'
    );
  });

  test('Falls back to the code itself when a coding carries no display', () => {
    const codeOnly = { resourceType: 'Condition', code: { coding: [{ system: SNOMED, code: '195967001' }] } };
    expect(getRowLabel(codeOnly as Condition, NO_REFERENCES)).toBe('195967001');
  });

  test('Names the record type rather than showing an id when nothing identifies it', () => {
    expect(getRowLabel({ resourceType: 'Immunization', id: 'imm-1', vaccineCode: {} } as never, NO_REFERENCES)).toBe(
      'Immunization'
    );
  });
});
