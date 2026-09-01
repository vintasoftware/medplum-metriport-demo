// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Box, Button, Center, Loader, Stack, Text } from '@mantine/core';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type { MetriportEmbedSession } from '../../utils/metriport';
import {
  buildMetriportPatientEmbedUrl,
  describeBotError,
  getMetriportSession,
  linkMetriportPatient,
} from '../../utils/metriport';

/**
 * Metriport patient view, embedded in the patient chart.
 *
 * The embed token comes from the `metriport-embed-token` bot, which also resolves which Metriport
 * patient belongs to this chart. The token is short lived and stays in memory and in the iframe
 * URL fragment.
 *
 * A patient with no Metriport ID is connected on demand: the provider presses the button, and the
 * `metriport-link-patient` bot matches or creates the patient and starts a network query. Nothing
 * reaches Metriport until that press.
 *
 * @see https://docs.metriport.com/medical-api/getting-started/embedding
 */
export function MetriportTab(): JSX.Element {
  const medplum = useMedplum();
  const { patientId } = useParams();
  const [session, setSession] = useState<MetriportEmbedSession>();
  const [error, setError] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  // Generation counter, so a response for a previous patient never overwrites the current one.
  const requestRef = useRef(0);

  const loadSession = useCallback(async (): Promise<void> => {
    if (!patientId) {
      return;
    }

    const requestId = ++requestRef.current;

    try {
      const result = await getMetriportSession(medplum, patientId);
      if (requestRef.current === requestId) {
        setSession(result);
      }
    } catch (err) {
      if (requestRef.current === requestId) {
        setError(describeBotError(err));
      }
    }
  }, [medplum, patientId]);

  useEffect(() => {
    setSession(undefined);
    setError(undefined);
    void loadSession();
  }, [loadSession]);

  const handleConnect = async (): Promise<void> => {
    if (!patientId) {
      return;
    }

    setConnecting(true);
    setError(undefined);
    try {
      const result = await linkMetriportPatient(medplum, patientId);
      if (result.status === 'linked') {
        await loadSession();
      } else {
        setError('Metriport could not match or create this patient.');
      }
    } catch (err) {
      setError(describeBotError(err));
    } finally {
      setConnecting(false);
    }
  };

  if (error) {
    return (
      <Box p="md">
        <Alert color="red" icon={<IconAlertTriangle />} title="Could not connect to Metriport">
          {error}
        </Alert>
      </Box>
    );
  }

  if (!session) {
    return (
      <Center h={200}>
        <Loader />
      </Center>
    );
  }

  if (session.status === 'not-linked') {
    return (
      <Center h={200}>
        <Stack align="center" gap="xs">
          <Text fw={500}>This patient is not connected to Metriport</Text>
          <Text size="sm" c="dimmed" ta="center" maw={480}>
            Connecting sends this patient&apos;s demographics to Metriport, then searches the health data networks for
            their records. Results take a few minutes to arrive.
          </Text>
          <Button mt="xs" loading={connecting} onClick={() => void handleConnect()}>
            Connect to Metriport
          </Button>
        </Stack>
      </Center>
    );
  }

  return (
    <Box style={{ flex: 1, minHeight: 0, height: '100%' }}>
      <iframe
        title="Metriport"
        src={buildMetriportPatientEmbedUrl(session)}
        style={{ width: '100%', height: '100%', border: 'none' }}
      />
    </Box>
  );
}
