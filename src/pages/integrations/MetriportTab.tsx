// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Center,
  Flex,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Tabs,
  Text,
  Tooltip,
} from '@mantine/core';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { usePatient } from '../../hooks/usePatient';
import type { MetriportEmbedSession } from '../../utils/metriport';
import {
  buildMetriportPatientEmbedUrl,
  describeBotError,
  getMetriportSession,
  isMetriportLinked,
  linkMetriportPatient,
} from '../../utils/metriport';
import { MetriportImportPanel } from './MetriportImportPanel';
import { DATE_RANGE_OPTIONS, DEFAULT_DATE_RANGE } from './MetriportImportPanel.utils';

const RECORD_VIEW = 'record';
const IMPORT_VIEW = 'import';

/**
 * Metriport patient view, embedded in the patient chart.
 *
 * Two views share the tab, switched by the same pill tabs the chart uses one level up, and
 * addressed by the URL so a refresh or a shared link lands in the same place. **Patient record** is
 * the Metriport embed, which is read only: the embed token comes from the `metriport-embed-token`
 * bot, which also resolves which Metriport patient belongs to this chart. The token is short lived
 * and stays in memory and in the iframe URL fragment. **Import records** is where data moves the
 * other way, into the chart.
 *
 * Whether the patient is connected is read off the Patient the chart has already loaded, so the tab
 * decides what to render without a round trip, and the embed token is fetched only for the view that
 * frames Metriport. Landing on the import view therefore costs no embed token at all: it mints no
 * Metriport credential, and the import view's own read starts immediately rather than behind a bot
 * execution it has no use for.
 *
 * A patient with no Metriport ID is connected on demand: the provider presses the button, and the
 * `metriport-link-patient` bot matches or creates the patient and starts a network query. Nothing
 * reaches Metriport until that press, and neither view has anything to show before it, so the tabs
 * appear only once the patient is connected.
 *
 * @see https://docs.metriport.com/medical-api/getting-started/embedding
 */
export function MetriportTab(): JSX.Element {
  const medplum = useMedplum();
  const patient = usePatient();
  const patientId = patient?.id;
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') === IMPORT_VIEW ? IMPORT_VIEW : RECORD_VIEW;
  const range = searchParams.get('range') ?? DEFAULT_DATE_RANGE;
  const [session, setSession] = useState<MetriportEmbedSession>();
  const [error, setError] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  // Set by a successful link, because the Patient the chart holds was read before the bot stamped
  // the identifier onto it.
  const [justLinked, setJustLinked] = useState(false);
  const linked = justLinked || (patient ? isMetriportLinked(patient) : undefined);
  // Bumped to re-read Metriport. A network query keeps arriving after the chart is open, so the
  // import view needs a way to catch up without a full page reload. The refresh button below and the
  // retry inside the panel both come here, so there is one counter rather than two.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  // Generation counter, so a response for a previous patient never overwrites the current one.
  const requestRef = useRef(0);

  const updateParams = useCallback(
    (changes: Record<string, string | undefined>): void => {
      setSearchParams(
        (params) => {
          const updated = new URLSearchParams(params);
          for (const [key, value] of Object.entries(changes)) {
            if (value) {
              updated.set(key, value);
            } else {
              updated.delete(key);
            }
          }
          return updated;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

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

  // The token is only worth minting for the view that frames Metriport, and only once: it outlives
  // a switch to the import view and back.
  useEffect(() => {
    if (view !== RECORD_VIEW || !linked || session) {
      return;
    }
    void loadSession();
  }, [loadSession, view, linked, session]);

  // A different patient invalidates the token that was issued for the last one.
  useEffect(() => {
    setSession(undefined);
    setError(undefined);
    setJustLinked(false);
  }, [patientId]);

  const handleConnect = async (): Promise<void> => {
    if (!patientId) {
      return;
    }

    setConnecting(true);
    setError(undefined);
    try {
      const result = await linkMetriportPatient(medplum, patientId);
      if (result.status === 'linked') {
        setJustLinked(true);
      } else {
        setError('Metriport could not match or create this patient.');
      }
    } catch (err) {
      setError(describeBotError(err));
    } finally {
      setConnecting(false);
    }
  };

  // The embed bot can still report a patient the identifier says is connected as not connected, if
  // the identifier was removed since the chart read it. Either answer lands on the same view.
  const connected = linked && session?.status !== 'not-linked';

  if (!patientId || linked === undefined) {
    return (
      <Center h={200}>
        <Loader />
      </Center>
    );
  }

  if (!connected) {
    return (
      <Center h={200}>
        <Stack align="center" gap="xs">
          {error ? (
            <Alert color="red" icon={<IconAlertTriangle />} title="Could not connect to Metriport">
              {error}
            </Alert>
          ) : (
            <>
              <Text fw={500}>This patient is not connected to Metriport</Text>
              <Text size="sm" c="dimmed" ta="center" maw={480}>
                Connecting sends this patient&apos;s demographics to Metriport, then searches the health data networks
                for their records. Results take a few minutes to arrive.
              </Text>
            </>
          )}
          <Button mt="xs" loading={connecting} onClick={() => void handleConnect()}>
            Connect to Metriport
          </Button>
        </Stack>
      </Center>
    );
  }

  return (
    <Stack gap={0} h="100%" style={{ minHeight: 0 }}>
      <Paper radius={0} style={{ borderBottom: '1px solid var(--app-shell-border-color)' }}>
        <Flex h={56} align="center" justify="space-between" px="md" gap="sm">
          <Tabs
            value={view}
            onChange={(next) =>
              updateParams({ view: next === IMPORT_VIEW ? IMPORT_VIEW : undefined, category: undefined })
            }
            variant="unstyled"
            className="pill-tabs"
          >
            <Tabs.List>
              <Tabs.Tab value={RECORD_VIEW}>Patient record</Tabs.Tab>
              <Tabs.Tab value={IMPORT_VIEW}>Import records</Tabs.Tab>
            </Tabs.List>
          </Tabs>
          {view === IMPORT_VIEW && (
            <Group gap="xs" wrap="nowrap">
              <Select
                size="xs"
                w={150}
                aria-label="Date range"
                data={DATE_RANGE_OPTIONS}
                value={range}
                onChange={(next) => updateParams({ range: next ?? DEFAULT_DATE_RANGE })}
                allowDeselect={false}
              />
              <Tooltip label="Read Metriport again">
                <ActionIcon variant="subtle" aria-label="Refresh" onClick={reload}>
                  <IconRefresh size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          )}
        </Flex>
      </Paper>
      <Box style={{ flex: 1, minHeight: 0 }}>
        {view === IMPORT_VIEW ? (
          <MetriportImportPanel patientId={patientId} range={range} reloadKey={reloadKey} onReload={reload} />
        ) : (
          <MetriportRecordView session={session} error={error} />
        )}
      </Box>
    </Stack>
  );
}

/**
 * The embedded patient view, and what stands in for it until its token arrives.
 *
 * The token is fetched when this view is shown rather than when the tab opens, so a failure here
 * leaves the import view next door working.
 *
 * @param props - The MetriportRecordView React props.
 * @returns The MetriportRecordView React node.
 */
function MetriportRecordView(props: {
  readonly session?: MetriportEmbedSession;
  readonly error?: string;
}): JSX.Element {
  const { session, error } = props;

  if (error) {
    return (
      <Box p="md">
        <Alert color="red" icon={<IconAlertTriangle />} title="Could not connect to Metriport">
          {error}
        </Alert>
      </Box>
    );
  }

  if (session?.status !== 'ok') {
    return (
      <Center h={200}>
        <Loader />
      </Center>
    );
  }

  return (
    <iframe
      title="Metriport"
      src={buildMetriportPatientEmbedUrl(session)}
      style={{ width: '100%', height: '100%', border: 'none' }}
    />
  );
}
