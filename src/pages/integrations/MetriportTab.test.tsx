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
import { METRIPORT_EMBED_TOKEN_BOT, METRIPORT_LINK_PATIENT_BOT } from '../../utils/metriport';
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

  const setup = (): ReturnType<typeof render> => {
    return render(
      <MemoryRouter initialEntries={[`/Patient/${HomerSimpson.id}/metriport`]}>
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

    expect(executeBot).toHaveBeenCalledTimes(1);
    expect(executeBot).toHaveBeenCalledWith(
      METRIPORT_EMBED_TOKEN_BOT,
      { patientId: HomerSimpson.id },
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

    expect(await screen.findByText('Could not connect to Metriport')).toBeInTheDocument();
    expect(
      screen.getByText('Metriport: Zip must be a string consisting of 5 numbers, on [address,0,zip] (400)')
    ).toBeInTheDocument();
  });

  test('Shows an error when the bot fails', async () => {
    vi.spyOn(medplum, 'executeBot').mockRejectedValue(new Error('Metriport returned 401'));

    setup();

    expect(await screen.findByText('Could not connect to Metriport')).toBeInTheDocument();
    expect(screen.getByText('Metriport returned 401')).toBeInTheDocument();
  });
});
