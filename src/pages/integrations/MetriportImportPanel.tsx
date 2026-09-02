// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Button, Center, List, Loader, Paper, Stack, Table, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconRefresh } from '@tabler/icons-react';
import type { JSX } from 'react';
import { isBotTimeout } from '../../utils/metriport';
import type { MetriportImportCategory } from './MetriportImportPanel.utils';
import { MAX_REVIEW_ROWS, METRIPORT_IMPORT_CATEGORIES } from './MetriportImportPanel.utils';
import { MetriportResourceReview } from './MetriportResourceReview';
import { useMetriportImport } from './useMetriportImport';

export interface MetriportImportPanelProps {
  readonly patientId: string;
  /** A value from DATE_RANGE_OPTIONS, owned by the tab header. */
  readonly range: string;
  /** Changes when Metriport should be read again. */
  readonly reloadKey: number;
  /** Asks for that read. The refresh button in the header does the same thing. */
  readonly onReload: () => void;
}

/**
 * Import records from Metriport into the chart, one record at a time.
 *
 * Two levels, so no step asks the provider to accept a whole record: the category counts, and then
 * one row per record for whichever category they open. All of the reading and writing lives in
 * {@link useMetriportImport}; this renders it.
 *
 * @param props - The MetriportImportPanel React props.
 * @returns The MetriportImportPanel React node.
 */
export function MetriportImportPanel(props: MetriportImportPanelProps): JSX.Element {
  const { patientId, range, reloadKey, onReload } = props;
  const {
    counts,
    countsError,
    category,
    selectedKeys,
    importedKeys,
    importing,
    openCategory,
    toggle,
    toggleMany,
    importRecords,
  } = useMetriportImport(patientId, range, reloadKey);

  if (category) {
    return (
      <Stack p="md" gap="md" h="100%" style={{ minHeight: 0 }}>
        {category.status === 'loading' && (
          <Center h={200}>
            <Loader />
          </Center>
        )}
        {category.status === 'error' && (
          <MetriportReadError
            title={`Could not read ${category.category.label}`}
            message={category.message}
            onRetry={onReload}
          />
        )}
        {category.status === 'ready' && (
          <MetriportResourceReview
            category={category.category}
            rows={category.rows}
            selectedKeys={selectedKeys}
            importedKeys={importedKeys}
            importing={importing}
            onBack={() => openCategory(undefined)}
            onToggle={toggle}
            onToggleVisible={toggleMany}
            onImport={importRecords}
          />
        )}
      </Stack>
    );
  }

  if (countsError) {
    return (
      <Stack p="md">
        <MetriportReadError title="Could not read Metriport data" message={countsError} onRetry={onReload} />
      </Stack>
    );
  }

  if (!counts) {
    return (
      <Center h={200}>
        <Loader />
      </Center>
    );
  }

  return (
    <Stack p="md" gap="md">
      <Paper withBorder radius="md">
        <Table horizontalSpacing="md" verticalSpacing="sm">
          <Table.Tbody>
            {METRIPORT_IMPORT_CATEGORIES.map((entry) => {
              // Metriport's count of records, which a category's own list can differ from. The note
              // below the table explains why.
              const count = countFor(entry, counts);
              return (
                <Table.Tr key={entry.id}>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {entry.label}
                    </Text>
                  </Table.Td>
                  <Table.Td w={150}>
                    <Text size="sm" c="dimmed">
                      {count.toLocaleString()} {count === 1 ? 'record' : 'records'}
                    </Text>
                  </Table.Td>
                  <Table.Td w={210} ta="right">
                    <ReviewAction count={count} onOpen={() => openCategory(entry.id)} />
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Paper>
      <Alert variant="light" color="blue" icon={<IconInfoCircle />} title="About these records">
        <List size="sm" spacing={6}>
          <List.Item>
            They come from other providers through the health data networks. Nothing joins this chart until you import
            it.
          </List.Item>
          <List.Item>Anything already in the chart is marked, and cannot be added twice.</List.Item>
          <List.Item>
            These counts will not always match the Patient record view next door. This list shows every record, and that
            view groups them, so one problem seen at four visits is four records here and often one line there.
          </List.Item>
          <List.Item>Only problems, allergies, medications and immunizations can be imported today.</List.Item>
        </List>
      </Alert>
    </Stack>
  );
}

/**
 * A failed Metriport read, with a retry.
 *
 * A time limit is called out for what it is. Metriport builds the consolidated bundle on the first
 * read after a network query, so the read that runs out of time is also the one that starts the
 * work, and trying again shortly usually succeeds.
 *
 * @param props - The MetriportReadError React props.
 * @returns The MetriportReadError React node.
 */
function MetriportReadError(props: {
  readonly title: string;
  readonly message: string;
  readonly onRetry: () => void;
}): JSX.Element {
  const { title, message, onRetry } = props;
  const timedOut = isBotTimeout(message);
  return (
    <Alert
      color={timedOut ? 'orange' : 'red'}
      icon={<IconAlertTriangle />}
      title={timedOut ? 'Metriport is still preparing this record' : title}
    >
      <Stack gap="sm" align="flex-start">
        <Text size="sm">
          {timedOut
            ? 'Metriport assembles a patient’s records the first time they are read after a network query, which can take a few minutes. That work has now started. Try again shortly.'
            : message}
        </Text>
        <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={onRetry}>
          Try again
        </Button>
      </Stack>
    </Alert>
  );
}

function ReviewAction(props: { readonly count: number; readonly onOpen: () => void }): JSX.Element {
  const { count, onOpen } = props;
  if (count > MAX_REVIEW_ROWS) {
    return (
      <Tooltip label="Too many records to list. Narrow the date range above.">
        <Button size="xs" variant="default" disabled>
          Narrow the dates
        </Button>
      </Tooltip>
    );
  }
  return (
    <Button size="xs" variant="light" disabled={count === 0} onClick={onOpen}>
      Review
    </Button>
  );
}

function countFor(entry: MetriportImportCategory, counts: Record<string, number>): number {
  return entry.resourceTypes.reduce((total, resourceType) => total + (counts[resourceType] ?? 0), 0);
}
