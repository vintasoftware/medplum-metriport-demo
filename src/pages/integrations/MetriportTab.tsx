// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Box, Center, Loader, Stack, Text } from '@mantine/core';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type { MetriportEmbedSession } from '../../utils/metriport';
import { buildMetriportPatientEmbedUrl, describeBotError, openMetriportSession } from '../../utils/metriport';

/**
 * Metriport patient view, embedded in the patient chart.
 *
 * The embed token comes from the `metriport-embed-token` bot, which also resolves which Metriport
 * patient belongs to this chart. The token is short lived and stays in memory and in the iframe
 * URL fragment.
 *
 * A patient who is not linked to Metriport yet is linked on first view by the
 * `metriport-link-patient` bot: match first, then create. That sends demographics to Metriport,
 * which the bot records as a disclosure AuditEvent.
 *
 * @see https://docs.metriport.com/medical-api/getting-started/embedding
 */
export function MetriportTab(): JSX.Element {
  const medplum = useMedplum();
  const { patientId } = useParams();
  const [session, setSession] = useState<MetriportEmbedSession>();
  const [error, setError] = useState<string>();
  const [linking, setLinking] = useState(false);
  // Generation counter, so a response for a previous patient never overwrites the current one.
  const requestRef = useRef(0);

  const loadSession = useCallback(async (): Promise<void> => {
    if (!patientId) {
      return;
    }

    const requestId = ++requestRef.current;
    const isCurrent = (): boolean => requestRef.current === requestId;

    try {
      const result = await openMetriportSession(medplum, patientId, () => {
        if (isCurrent()) {
          setLinking(true);
        }
      });

      if (isCurrent()) {
        setSession(result);
      }
    } catch (err) {
      if (isCurrent()) {
        setError(describeBotError(err));
      }
    } finally {
      if (isCurrent()) {
        setLinking(false);
      }
    }
  }, [medplum, patientId]);

  useEffect(() => {
    setSession(undefined);
    setError(undefined);
    void loadSession();
  }, [loadSession]);

  if (error) {
    return (
      <Box p="md">
        <Alert color="red" icon={<IconAlertTriangle />} title="Could not open Metriport">
          {error}
        </Alert>
      </Box>
    );
  }

  if (!session) {
    return (
      <Center h={200}>
        <Stack align="center" gap="xs">
          <Loader />
          {linking && (
            <Text size="sm" c="dimmed">
              Linking this patient to Metriport…
            </Text>
          )}
        </Stack>
      </Center>
    );
  }

  if (session.status === 'not-linked') {
    return (
      <Center h={200}>
        <Stack align="center" gap="xs">
          <Text fw={500}>This patient is not linked to Metriport</Text>
          <Text size="sm" c="dimmed" ta="center" maw={480}>
            Metriport has no record for this patient, and could not create one.
          </Text>
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
