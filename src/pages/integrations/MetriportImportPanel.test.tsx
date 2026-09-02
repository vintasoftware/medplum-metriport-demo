// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import type { Bundle, Condition } from '@medplum/fhirtypes';
import { HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MetriportImportPanel } from './MetriportImportPanel';

const SNOMED = 'http://snomed.info/sct';

const asthma: Condition = {
  resourceType: 'Condition',
  id: 'metriport-asthma',
  subject: { reference: 'Patient/metriport-patient-1' },
  recordedDate: '2026-02-17',
  recorder: { reference: 'Organization/org-1', display: 'Riverside Family Medicine' },
  code: { text: 'Asthma', coding: [{ system: SNOMED, code: '195967001' }] },
};

const diabetes: Condition = {
  resourceType: 'Condition',
  id: 'metriport-diabetes',
  subject: { reference: 'Patient/metriport-patient-1' },
  recordedDate: '2025-01-09',
  code: { text: 'Type 2 diabetes mellitus', coding: [{ system: SNOMED, code: '44054006' }] },
};

const CONDITION_BUNDLE: Bundle = {
  resourceType: 'Bundle',
  type: 'searchset',
  entry: [
    { fullUrl: 'urn:uuid:patient', resource: { resourceType: 'Patient', id: 'metriport-patient-1' } },
    { fullUrl: 'urn:uuid:asthma', resource: asthma },
    { fullUrl: 'urn:uuid:diabetes', resource: diabetes },
  ],
};

/**
 * @param id - The resource id.
 * @param text - The vaccine name.
 * @param code - The CVX code.
 * @param date - The date it was given.
 * @returns An immunization shaped the way network data delivers one.
 */
function immunization(id: string, text: string, code: string, date: string): object {
  return {
    resourceType: 'Immunization',
    id,
    status: 'completed',
    patient: { reference: 'Patient/metriport-patient-1' },
    occurrenceDateTime: date,
    vaccineCode: { text, coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code }] },
  };
}

/**
 * The tab owns the reload counter and passes it down with the callback that bumps it, so the panel's
 * retry and the header's refresh are one thing. This stands in for that.
 *
 * @param props - The patient whose chart is open.
 * @returns The panel, wired the way the tab wires it.
 */
function ReloadHarness(props: { readonly patientId: string }): JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <MetriportImportPanel
      patientId={props.patientId}
      range="all"
      reloadKey={reloadKey}
      onReload={() => setReloadKey((key) => key + 1)}
    />
  );
}

describe('MetriportImportPanel', () => {
  let medplum: MockClient;

  beforeEach(() => {
    medplum = new MockClient();
    vi.restoreAllMocks();
  });

  /** Stands for the tab, which owns the single reload counter the panel and its retry both use. */
  const setup = (search = ''): ReturnType<typeof render> =>
    render(
      <MemoryRouter initialEntries={[`/Patient/${HomerSimpson.id}/metriport${search}`]}>
        <MedplumProvider medplum={medplum}>
          <MantineProvider>
            <ReloadHarness patientId={HomerSimpson.id as string} />
          </MantineProvider>
        </MedplumProvider>
      </MemoryRouter>
    );

  /**
   * @param chartConditions - What the chart already holds, for the "In chart" marks.
   * @returns The executeBatch spy, so a test can read the transaction that was sent.
   */
  function mockMetriport(chartConditions: Condition[] = []): ReturnType<typeof vi.spyOn> {
    vi.spyOn(medplum, 'executeBot').mockImplementation(async (_botId, input) => {
      const { action } = input as { action: string };
      if (action === 'count') {
        return { status: 'counts', total: 2, resources: { Condition: 2 } };
      }
      return { status: 'bundle', bundle: CONDITION_BUNDLE };
    });
    vi.spyOn(medplum, 'searchResources').mockResolvedValue(chartConditions as never);
    return vi.spyOn(medplum, 'executeBatch').mockResolvedValue({
      resourceType: 'Bundle',
      type: 'transaction-response',
      entry: [{ response: { status: '201' } }],
    });
  }

  test('Lists the categories from the counts, and reads no record to do it', async () => {
    const executeBot = vi.spyOn(medplum, 'executeBot').mockResolvedValue({
      status: 'counts',
      total: 2,
      resources: { Condition: 2 },
    });

    setup();

    expect(await screen.findByText('Problems')).toBeInTheDocument();
    expect(screen.getByText('2 records')).toBeInTheDocument();
    expect(executeBot).toHaveBeenCalledTimes(1);
    expect(executeBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'count' }),
      'application/json'
    );
  });

  test('Keeps the record count and adds what the category listed, rather than replacing it', async () => {
    mockMetriport();

    setup();

    expect(await screen.findByText('2 records')).toBeInTheDocument();

    // Open the category, then come back. The record count must still read the same.
    await userEvent.click(screen.getAllByRole('button', { name: 'Review' })[0]);
    expect(await screen.findByText('Type 2 diabetes mellitus')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back to categories' }));

    expect(await screen.findByText('2 records')).toBeInTheDocument();
  });

  test('Reads Metriport once for a category, however often it is opened', async () => {
    const executeBot = mockMetriport();

    setup();

    expect(await screen.findByText('2 records')).toBeInTheDocument();

    for (let visit = 0; visit < 2; visit++) {
      await userEvent.click(screen.getAllByRole('button', { name: 'Review' })[0]);
      expect(await screen.findByText('Type 2 diabetes mellitus')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Back to categories' }));
      expect(await screen.findByText('2 records')).toBeInTheDocument();
    }

    // One count and one fetch, for two visits to the category and three renders of the list. The
    // chart is read again every time: it is cheap, and an import changes what it answers.
    const actions = vi.mocked(medplum.executeBot).mock.calls.map((call) => (call[1] as { action: string }).action);
    expect(actions).toStrictEqual(['count', 'fetch']);
    expect(executeBot).not.toHaveBeenCalled();
    expect(vi.mocked(medplum.searchResources).mock.calls.length).toBeGreaterThan(1);
  });

  test('Asks Metriport again on a refresh, rather than repeating what it said', async () => {
    let fetches = 0;
    vi.spyOn(medplum, 'executeBot').mockImplementation(async (_botId, input) => {
      const { action } = input as { action: string };
      if (action === 'count') {
        return { status: 'counts', total: 2, resources: { Condition: 2 } };
      }
      if (++fetches === 1) {
        throw new Error('RequestId: abc Error: Task timed out after 60.00 seconds');
      }
      return { status: 'bundle', bundle: CONDITION_BUNDLE };
    });
    vi.spyOn(medplum, 'searchResources').mockResolvedValue([] as never);

    setup('?category=problems');

    expect(await screen.findByText('Metriport is still preparing this record')).toBeInTheDocument();

    // A network query keeps arriving after the chart is open, so a refresh has to reach Metriport
    // again — the counts included, cached or not.
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Type 2 diabetes mellitus')).toBeInTheDocument();
    const counts = vi
      .mocked(medplum.executeBot)
      .mock.calls.filter((call) => (call[1] as { action: string }).action === 'count');
    expect(counts).toHaveLength(2);
  });

  test('Gives indistinguishable records a row each, rather than merging them', async () => {
    vi.spyOn(medplum, 'executeBot').mockImplementation(async (_botId, input) => {
      const { action } = input as { action: string };
      if (action === 'count') {
        return { status: 'counts', total: 3, resources: { Immunization: 3 } };
      }
      // Two of the three carry the same vaccine and the same date, and no identifier.
      return {
        status: 'bundle',
        bundle: {
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [
            { fullUrl: 'urn:uuid:i1', resource: immunization('i1', 'Influenza, seasonal', '140', '2025-10-04') },
            { fullUrl: 'urn:uuid:i2', resource: immunization('i2', 'Influenza, seasonal', '140', '2025-10-04') },
            { fullUrl: 'urn:uuid:i3', resource: immunization('i3', 'Tdap', '115', '2024-06-01') },
          ],
        },
      };
    });
    vi.spyOn(medplum, 'searchResources').mockResolvedValue([] as never);

    setup('?category=immunizations');

    expect(await screen.findByText('3 records')).toBeInTheDocument();
    expect(screen.getAllByText('Influenza, seasonal')).toHaveLength(2);
  });

  test('Reads the chart for the same patient, which is what the marking rests on', async () => {
    mockMetriport();

    setup('?category=problems');

    await screen.findByText('Type 2 diabetes mellitus');

    // A wrong search parameter here would mark nothing, and every record would read "Not in chart".
    expect(medplum.searchResources).toHaveBeenCalledWith(
      'Condition',
      expect.objectContaining({ patient: `Patient/${HomerSimpson.id}` })
    );
  });

  test('Keeps the counts when a category is open from the start, so Back is not a dead end', async () => {
    mockMetriport();

    // Arriving with a category already open runs both reads at once. Give them a shared cancellation
    // counter and the second discards the first, leaving Back on a spinner for ever.
    setup('?category=problems');

    await screen.findByText('Type 2 diabetes mellitus');
    await userEvent.click(screen.getByRole('button', { name: 'Back to categories' }));

    expect(await screen.findByText('Problems')).toBeInTheDocument();
  });

  test('Marks a record the chart already holds and refuses to select it', async () => {
    mockMetriport([{ ...asthma, id: 'chart-asthma' }]);

    setup('?category=problems');

    // "Not in chart" is the default, so the known record only shows under "All".
    expect(await screen.findByText('Type 2 diabetes mellitus')).toBeInTheDocument();
    expect(screen.getByText('2 records · 1 already in chart')).toBeInTheDocument();
    expect(screen.queryByText('Asthma')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'In chart' }));

    expect(await screen.findByText('Asthma')).toBeInTheDocument();
    // "In chart" is both a row badge and a filter option, so scope this to the list.
    expect(within(screen.getByRole('table')).getByText('In chart')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Asthma' })).toBeDisabled();

    // The third filter isolates what the chart already holds, so it can be found without scrolling.
    await userEvent.click(screen.getByRole('radio', { name: 'In chart' }));

    expect(await screen.findByText('Asthma')).toBeInTheDocument();
    expect(screen.queryByText('Type 2 diabetes mellitus')).not.toBeInTheDocument();
  });

  test('Disables the filter when the chart holds none of the category', async () => {
    mockMetriport();

    setup('?category=problems');

    expect(await screen.findByText('2 records')).toBeInTheDocument();
    // Both filters would show the same rows, so pressing it could only look broken.
    expect(screen.getByRole('radio', { name: 'In chart' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Not in chart' })).toBeDisabled();
  });

  test('Imports the ticked record, repointed at the chart patient and guarded against a repeat', async () => {
    const executeBatch = mockMetriport();

    setup('?category=problems');

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Type 2 diabetes mellitus' }));
    await userEvent.click(screen.getByRole('button', { name: 'Import 1 selected' }));

    await waitFor(() => expect(executeBatch).toHaveBeenCalledTimes(1));

    const transaction = executeBatch.mock.calls[0][0] as Bundle;
    expect(transaction.type).toBe('transaction');
    expect(transaction.entry).toHaveLength(1);

    const [entry] = transaction.entry ?? [];
    const imported = entry.resource as Condition;
    expect(imported.resourceType).toBe('Condition');
    expect(imported.subject?.reference).toBe(`Patient/${HomerSimpson.id}`);
    expect(entry.request?.method).toBe('POST');
    expect(entry.request?.ifNoneExist).toBe(
      `patient=Patient/${HomerSimpson.id}&code=${SNOMED}|44054006&recorded-date=2025-01-09`
    );

    // The row stays visible, marked, so the import is confirmed rather than silently removed.
    expect(await screen.findByText('Imported')).toBeInTheDocument();
  });

  test('Announces the change, so the patient summary stops showing stale data', async () => {
    const executeBatch = mockMetriport();
    const notify = vi.spyOn(medplum, 'notifyResourceModified');

    setup('?category=problems');

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Type 2 diabetes mellitus' }));
    await userEvent.click(screen.getByRole('button', { name: 'Import 1 selected' }));

    await waitFor(() => expect(executeBatch).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith({ resourceType: 'Condition', operation: 'create' });
  });

  test('Imports a single record from its own button', async () => {
    const executeBatch = mockMetriport();

    setup('?category=problems');

    await userEvent.click(await screen.findByRole('button', { name: 'Import Type 2 diabetes mellitus' }));

    await waitFor(() => expect(executeBatch).toHaveBeenCalledTimes(1));
    const transaction = executeBatch.mock.calls[0][0] as Bundle;
    expect(transaction.entry).toHaveLength(1);
    expect((transaction.entry?.[0]?.resource as Condition).code?.coding?.[0]?.code).toBe('44054006');
  });

  test('Asks for a narrower range instead of listing too many records', async () => {
    vi.spyOn(medplum, 'executeBot').mockImplementation(async (_botId, input) => {
      const { action } = input as { action: string };
      if (action === 'count') {
        return { status: 'counts', total: 900, resources: { Condition: 900 } };
      }
      return { status: 'too-many', count: 900, limit: 500 };
    });
    vi.spyOn(medplum, 'searchResources').mockResolvedValue([] as never);

    setup('?category=problems');

    expect(await screen.findByText(/Narrow the date range/)).toBeInTheDocument();
  });

  test('Adds up the medication types the networks report separately', async () => {
    const executeBot = vi.spyOn(medplum, 'executeBot').mockResolvedValue({
      status: 'counts',
      total: 9,
      resources: { MedicationRequest: 4, MedicationStatement: 3, MedicationDispense: 2 },
    });

    setup();

    expect(await screen.findByText('Medications')).toBeInTheDocument();
    expect(screen.getByText('9 records')).toBeInTheDocument();
    // One count request, with no type list: the bot counts the whole record and filters the reply.
    expect(executeBot).toHaveBeenCalledTimes(1);
    expect(executeBot).toHaveBeenCalledWith(
      expect.anything(),
      { patientId: HomerSimpson.id, action: 'count', dateFrom: undefined },
      'application/json'
    );
  });

  test('Names the kind of each medication, so reported is not read as prescribed', async () => {
    vi.spyOn(medplum, 'executeBot').mockImplementation(async (_botId, input) => {
      const { action } = input as { action: string };
      if (action === 'count') {
        return { status: 'counts', total: 2, resources: { MedicationRequest: 1, MedicationStatement: 1 } };
      }
      return {
        status: 'bundle',
        bundle: {
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [
            {
              fullUrl: 'urn:uuid:mr',
              resource: {
                resourceType: 'MedicationRequest',
                id: 'mr',
                status: 'active',
                intent: 'order',
                subject: { reference: 'Patient/metriport-patient-1' },
                authoredOn: '2026-01-02',
                medicationCodeableConcept: { text: 'Metformin 500 MG', coding: [{ code: '860975' }] },
              },
            },
            {
              fullUrl: 'urn:uuid:ms',
              resource: {
                resourceType: 'MedicationStatement',
                id: 'ms',
                status: 'active',
                subject: { reference: 'Patient/metriport-patient-1' },
                effectiveDateTime: '2025-06-01',
                medicationCodeableConcept: { text: 'Lisinopril 10 MG', coding: [{ code: '314076' }] },
              },
            },
          ],
        },
      };
    });
    vi.spyOn(medplum, 'searchResources').mockResolvedValue([] as never);

    setup('?category=medications');

    expect(await screen.findByText('Metformin 500 MG')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Kind' })).toBeInTheDocument();
    expect(screen.getByText('Prescribed')).toBeInTheDocument();
    expect(screen.getByText('Reported')).toBeInTheDocument();
  });

  test('Offers a retry when the bot runs out of time, and says why', async () => {
    const executeBot = vi
      .spyOn(medplum, 'executeBot')
      .mockRejectedValueOnce(new Error('RequestId: abc Error: Task timed out after 10.00 seconds'))
      .mockResolvedValue({ status: 'counts', total: 2, resources: { Condition: 2 } });

    setup();

    expect(await screen.findByText('Metriport is still preparing this record')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Problems')).toBeInTheDocument();
    expect(executeBot).toHaveBeenCalledTimes(2);
  });

  test('Shows the reason when the bot fails', async () => {
    vi.spyOn(medplum, 'executeBot').mockRejectedValue(new Error('Metriport returned 401'));

    setup();

    expect(await screen.findByText('Could not read Metriport data')).toBeInTheDocument();
    expect(screen.getByText('Metriport returned 401')).toBeInTheDocument();
  });
});
