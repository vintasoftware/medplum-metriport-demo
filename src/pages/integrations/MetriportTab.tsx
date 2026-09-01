// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Box, Center, Loader, Stack, Text } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useMetriportAccess } from '../../hooks/useMetriportAccess';
import type { MetriportEmbedSession } from '../../utils/metriport';
import { buildMetriportPatientEmbedUrl, createMetriportEmbedSession } from '../../utils/metriport';

/**
 * Metriport patient view, embedded in the patient chart.
 *
 * The embed token comes from the `metriport-embed-token` bot, which also resolves which Metriport
 * patient belongs to this chart. The token is short lived and stays in memory and in the iframe
 * URL fragment.
 *
 * @see https://docs.metriport.com/medical-api/getting-started/embedding
 */
export function MetriportTab(): JSX.Element {
  const medplum = useMedplum();
  const { patientId } = useParams();
  const { botId } = useMetriportAccess();
  const [session, setSession] = useState<MetriportEmbedSession>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setSession(undefined);
    setError(undefined);

    if (!patientId || !botId) {
      return undefined;
    }

    createMetriportEmbedSession(medplum, botId, patientId)
      .then((result) => {
        if (active) {
          setSession(result);
        }
      })
      .catch((err) => {
        if (active) {
          setError(normalizeErrorString(err));
        }
      });

    return () => {
      active = false;
    };
  }, [medplum, botId, patientId]);

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
        <Loader />
      </Center>
    );
  }

  if (session.status === 'not-linked') {
    return (
      <Center h={200}>
        <Stack align="center" gap="xs">
          <Text fw={500}>This patient is not linked to Metriport</Text>
          <Text size="sm" c="dimmed">
            Medical records appear here once the patient is created in or matched to Metriport.
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
