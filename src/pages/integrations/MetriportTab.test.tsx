// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import type { Identifier } from '@medplum/fhirtypes';
import { HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  METRIPORT_CONSOLIDATED_BOT,
  METRIPORT_EMBED_TOKEN_BOT,
  METRIPORT_LINK_PATIENT_BOT,
  METRIPORT_PATIENT_IDENTIFIER_SYSTEM,
} from '../../utils/metriport';
import { MetriportTab } from './MetriportTab';

/**
 * @param botId - The first argument the tab passed to executeBot.
 * @returns Which bot it addressed. Bots are executed by identifier, never by ID.
 */
function botName(botId: unknown): string | undefined {
  return (botId as Identifier).value;
}

const OK_SESSION = {
  status: 'ok',
  token: 'test-token',
  embedBaseUrl: 'https://ehr.sandbox.metriport.com/embed/app',
  metriportPatientId: 'metriport-patient-1',
  environment: 'sandbox',
  expiresInSeconds: 900,
};

describe('MetriportTab', () => {
  let medplum: MockClient;

  beforeEach(() => {
    medplum = new MockClient();
    vi.restoreAllMocks();
  });

  /**
   * Stamps the Metriport patient ID onto the chart's Patient.
   *
   * The tab reads whether a patient is connected off the Patient rather than asking a bot, so a test
   * about either view has to connect the patient first.
   */
  const linkPatient = async (): Promise<void> => {
    await medplum.updateResource({
      ...HomerSimpson,
      identifier: [
        ...(HomerSimpson.identifier ?? []),
        { system: METRIPORT_PATIENT_IDENTIFIER_SYSTEM, value: 'metriport-patient-1' },
      ],
    });
  };

  const setup = (search = ''): ReturnType<typeof render> => {
    return render(
      <MemoryRouter initialEntries={[`/Patient/${HomerSimpson.id}/metriport${search}`]}>
        <MedplumProvider medplum={medplum}>
          <MantineProvider>
            <Routes>
              <Route path="/Patient/:patientId/metriport" element={<MetriportTab />} />
            </Routes>
          </MantineProvider>
        </MedplumProvider>
      </MemoryRouter>
    );
  };

  test('Renders the embed iframe with the token in the URL fragment', async () => {
    await linkPatient();
    const executeBot = vi.spyOn(medplum, 'executeBot').mockResolvedValue(OK_SESSION);

    setup();

    await waitFor(() => {
      const iframe = document.querySelector('iframe[title="Metriport"]');
      expect(iframe).toBeInTheDocument();
      expect(iframe).toHaveAttribute(
        'src',
        'https://ehr.sandbox.metriport.com/embed/app/patient/metriport-patient-1#access_token=test-token'
      );
    });

    expect(executeBot).toHaveBeenCalledWith(
      METRIPORT_EMBED_TOKEN_BOT,
      { patientId: HomerSimpson.id },
      'application/json'
    );
  });

  test('Connects the patient when the provider presses the button', async () => {
    let linked = false;
    const executeBot = vi.spyOn(medplum, 'executeBot').mockImplementation(async (botId) => {
      if (botName(botId) === METRIPORT_LINK_PATIENT_BOT.value) {
        linked = true;
        return { status: 'linked', metriportPatientId: 'metriport-patient-1' };
      }
      return linked ? OK_SESSION : { status: 'not-linked' };
    });

    setup();

    const button = await screen.findByRole('button', { name: 'Connect to Metriport' });
    expect(document.querySelector('iframe[title="Metriport"]')).not.toBeInTheDocument();

    await userEvent.click(button);

    await waitFor(() => {
      expect(document.querySelector('iframe[title="Metriport"]')).toBeInTheDocument();
    });

    expect(executeBot).toHaveBeenCalledWith(
      METRIPORT_LINK_PATIENT_BOT,
      { patientId: HomerSimpson.id, create: true },
      'application/json'
    );
  });

  test('Sends nothing to Metriport until the button is pressed', async () => {
    const executeBot = vi.spyOn(medplum, 'executeBot').mockResolvedValue({ status: 'not-linked' });

    setup();

    await screen.findByRole('button', { name: 'Connect to Metriport' });

    // Not one bot execution. An unconnected patient has nothing in Metriport to read and no embed
    // to frame, and the Patient the chart already holds is what says so.
    expect(executeBot).not.toHaveBeenCalled();
  });

  test('Mints no embed token when the import view is what was opened', async () => {
    await linkPatient();
    const executeBot = vi.spyOn(medplum, 'executeBot').mockImplementation(async (botId) => {
      if (botName(botId) === METRIPORT_CONSOLIDATED_BOT.value) {
        return { status: 'counts', resources: { Condition: 4 } };
      }
      return OK_SESSION;
    });

    setup('?view=import');

    expect(await screen.findByText('4 records')).toBeInTheDocument();

    // A refresh or a shared link landing here used to wait on a token for the view next door, and
    // mint a Metriport credential nobody framed. The counts now start on the first render instead.
    expect(executeBot).not.toHaveBeenCalledWith(METRIPORT_EMBED_TOKEN_BOT, expect.anything(), expect.anything());
    expect(executeBot).toHaveBeenCalledWith(
      METRIPORT_CONSOLIDATED_BOT,
      expect.objectContaining({ action: 'count' }),
      'application/json'
    );
  });

  test("Shows Metriport's reason when it rejects the demographics", async () => {
    // Medplum wraps a bot failure in JSON carrying errorMessage and a stack trace.
    vi.spyOn(medplum, 'executeBot').mockImplementation(async (botId) => {
      if (botName(botId) === METRIPORT_LINK_PATIENT_BOT.value) {
        throw new Error(
          JSON.stringify({
            errorType: 'MetriportApiError',
            errorMessage: 'Metriport: Zip must be a string consisting of 5 numbers, on [address,0,zip] (400)',
            trace: ['at metriportRequest'],
          })
        );
      }
      return { status: 'not-linked' };
    });

    setup();

    // Demographics only leave Medplum on the press, so the rejection only surfaces after it.
    await userEvent.click(await screen.findByRole('button', { name: 'Connect to Metriport' }));

    expect(await screen.findByText('Could not connect to Metriport')).toBeInTheDocument();
    expect(
      screen.getByText('Metriport: Zip must be a string consisting of 5 numbers, on [address,0,zip] (400)')
    ).toBeInTheDocument();
  });

  test('Switches to the import view and reads the Metriport counts', async () => {
    await linkPatient();
    const executeBot = vi.spyOn(medplum, 'executeBot').mockImplementation(async (botId) => {
      if (botName(botId) === METRIPORT_CONSOLIDATED_BOT.value) {
        return { status: 'counts', total: 12, resources: { Condition: 9, Immunization: 3 } };
      }
      return OK_SESSION;
    });

    setup();

    await userEvent.click(await screen.findByRole('tab', { name: 'Import records' }));

    expect(await screen.findByText('Problems')).toBeInTheDocument();
    expect(screen.getByText('9 records')).toBeInTheDocument();
    // A category Metriport returned nothing for cannot be opened. The button carries no number:
    // the count beside it does, and it is the count that changes once a category has been read.
    const reviewButtons = screen.getAllByRole('button', { name: 'Review' });
    expect(reviewButtons.filter((button) => !button.hasAttribute('disabled'))).toHaveLength(2);

    expect(executeBot).toHaveBeenCalledWith(
      METRIPORT_CONSOLIDATED_BOT,
      expect.objectContaining({ patientId: HomerSimpson.id, action: 'count' }),
      'application/json'
    );
  });

  test('Reads no Metriport data while the patient record view is open', async () => {
    await linkPatient();
    const executeBot = vi.spyOn(medplum, 'executeBot').mockResolvedValue(OK_SESSION);

    setup();

    await waitFor(() => expect(document.querySelector('iframe[title="Metriport"]')).toBeInTheDocument());

    expect(executeBot).toHaveBeenCalledTimes(1);
    expect(executeBot).not.toHaveBeenCalledWith(METRIPORT_CONSOLIDATED_BOT, expect.anything(), expect.anything());
  });

  test('Shows an error when the bot fails', async () => {
    await linkPatient();
    vi.spyOn(medplum, 'executeBot').mockRejectedValue(new Error('Metriport returned 401'));

    setup();

    expect(await screen.findByText('Could not connect to Metriport')).toBeInTheDocument();
    expect(screen.getByText('Metriport returned 401')).toBeInTheDocument();
  });
});
