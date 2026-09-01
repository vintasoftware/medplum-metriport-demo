// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MetriportTab } from './MetriportTab';

// The bot is located by name at runtime; the lookup itself is covered by useMetriportAccess.
vi.mock('../../hooks/useMetriportAccess', () => ({
  useMetriportAccess: () => ({ botId: 'bot-1', hasAccess: true, loading: false }),
}));

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

    expect(executeBot).toHaveBeenCalledWith('bot-1', { patientId: HomerSimpson.id }, 'application/json');
  });

  test('Shows an empty state when the patient is not linked to Metriport', async () => {
    vi.spyOn(medplum, 'executeBot').mockResolvedValue({ status: 'not-linked' });

    setup();

    expect(await screen.findByText('This patient is not linked to Metriport')).toBeInTheDocument();
    expect(document.querySelector('iframe[title="Metriport"]')).not.toBeInTheDocument();
  });

  test('Shows an error when the bot fails', async () => {
    vi.spyOn(medplum, 'executeBot').mockRejectedValue(new Error('Metriport returned 401'));

    setup();

    expect(await screen.findByText('Could not open Metriport')).toBeInTheDocument();
    expect(screen.getByText('Metriport returned 401')).toBeInTheDocument();
  });
});
