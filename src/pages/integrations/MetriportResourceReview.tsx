// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconArrowLeft, IconCheck, IconDownload, IconPlus } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { humanizeResourceType } from './MetriportImportPanel.fields';
import type { MetriportImportCategory, MetriportImportRow } from './MetriportImportPanel.utils';

export interface MetriportResourceReviewProps {
  readonly category: MetriportImportCategory;
  readonly rows: readonly MetriportImportRow[];
  readonly selectedKeys: ReadonlySet<string>;
  readonly importedKeys: ReadonlySet<string>;
  readonly importing: boolean;
  readonly onBack: () => void;
  readonly onToggle: (key: string, checked: boolean) => void;
  readonly onToggleVisible: (keys: string[], checked: boolean) => void;
  readonly onImport: (keys: string[]) => void;
}

/**
 * Level two of the import panel: one row per resource, reviewed and selected individually.
 *
 * A record already in the chart cannot be selected, and the default filter hides those rows, so the
 * provider reads what the chart is missing instead of the whole record. Two ways to import are
 * offered on the same row: the plus button takes that one record, the checkboxes take a batch.
 *
 * @param props - The MetriportResourceReview React props.
 * @returns The MetriportResourceReview React node.
 */
export function MetriportResourceReview(props: MetriportResourceReviewProps): JSX.Element {
  const { category, rows, selectedKeys, importedKeys, importing, onBack, onToggle, onToggleVisible, onImport } = props;
  const [filter, setFilter] = useState('new');
  // Medications arrive as requests, statements, dispenses and administrations. Under one heading
  // the kind has to be on the row, or a reported medication reads as a prescribed one.
  const showKind = category.resourceTypes.length > 1;

  // "Not in chart" hides what the chart already holds, but keeps a record imported in this session,
  // so the row confirms the import instead of disappearing.
  const notInChart = useMemo(() => rows.filter((row) => !row.inChart), [rows]);
  const inChartRows = useMemo(() => rows.filter((row) => row.inChart), [rows]);
  // With none of them in the chart there is nothing to switch to, so the control is disabled and its
  // tooltip says why.
  const inChartCount = inChartRows.length;
  const visibleRows = filter === 'new' ? notInChart : inChartRows;
  const visibleSelectable = visibleRows.filter((row) => !row.inChart && !importedKeys.has(row.key));
  const selectedVisible = visibleSelectable.filter((row) => selectedKeys.has(row.key));
  const selectedAll = visibleSelectable.length > 0 && selectedVisible.length === visibleSelectable.length;

  return (
    <Stack gap="sm" h="100%" style={{ minHeight: 0 }}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <ActionIcon variant="subtle" aria-label="Back to categories" onClick={onBack}>
            <IconArrowLeft size={18} />
          </ActionIcon>
          <Text fw={600}>{category.label}</Text>
          <Text size="sm" c="dimmed">
            {describeRows(rows.length, inChartCount)}
          </Text>
        </Group>
        <Tooltip
          label={
            inChartCount > 0
              ? `Switch between the ${inChartCount} already in the chart and the rest`
              : 'None of these is in the chart yet, so there is nothing to switch to'
          }
        >
          <Box>
            <SegmentedControl
              size="xs"
              value={filter}
              onChange={setFilter}
              disabled={inChartCount === 0}
              data={[
                { label: 'Not in chart', value: 'new' },
                { label: 'In chart', value: 'chart' },
              ]}
            />
          </Box>
        </Tooltip>
      </Group>

      {/* Takes the height the tab leaves it, so the list is as long as the window allows and the
          import footer stays in view rather than being pushed off the end of a long category. */}
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Table horizontalSpacing="sm" verticalSpacing="xs" highlightOnHover stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: 36 }}>
                <Checkbox
                  aria-label={`Select all shown ${category.label.toLowerCase()}`}
                  checked={selectedAll}
                  indeterminate={selectedVisible.length > 0 && !selectedAll}
                  disabled={visibleSelectable.length === 0}
                  onChange={(event) =>
                    onToggleVisible(
                      visibleSelectable.map((row) => row.key),
                      event.currentTarget.checked
                    )
                  }
                />
              </Table.Th>
              <Table.Th>Item</Table.Th>
              {showKind && <Table.Th style={{ width: 110 }}>Kind</Table.Th>}
              <Table.Th style={{ width: 110 }}>Date</Table.Th>
              <Table.Th style={{ width: 190 }}>Source</Table.Th>
              <Table.Th style={{ width: 150 }}>State</Table.Th>
              <Table.Th style={{ width: 44 }} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visibleRows.map((row) => {
              const imported = importedKeys.has(row.key);
              const locked = row.inChart || imported;
              return (
                <Table.Tr key={row.key} opacity={locked ? 0.6 : 1}>
                  <Table.Td>
                    <Checkbox
                      aria-label={`Select ${row.label}`}
                      checked={selectedKeys.has(row.key)}
                      disabled={locked}
                      onChange={(event) => onToggle(row.key, event.currentTarget.checked)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{row.label}</Text>
                  </Table.Td>
                  {showKind && (
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {humanizeResourceType(row.resource.resourceType)}
                      </Text>
                    </Table.Td>
                  )}
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {row.date ?? '—'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed" truncate>
                      {row.source ?? '—'}
                    </Text>
                  </Table.Td>
                  <Table.Td>{renderState(row, imported)}</Table.Td>
                  <Table.Td>
                    {!locked && (
                      <Tooltip label="Import only this record">
                        <ActionIcon
                          variant="subtle"
                          aria-label={`Import ${row.label}`}
                          disabled={importing}
                          onClick={() => onImport([row.key])}
                        >
                          <IconPlus size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
            {visibleRows.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={showKind ? 7 : 6}>
                  <Text size="sm" c="dimmed" ta="center" py="lg">
                    Nothing to add in this category for the selected dates.
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </ScrollArea>

      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {selectedVisible.length} selected
        </Text>
        <Button
          leftSection={<IconDownload size={16} />}
          loading={importing}
          disabled={selectedVisible.length === 0}
          onClick={() => onImport(selectedVisible.map((row) => row.key))}
        >
          {selectedVisible.length > 0 ? `Import ${selectedVisible.length} selected` : 'Import selected'}
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * The line beside the heading: how many records there are, and how many the chart already has. The
 * second part appears only when there is one, so a category with nothing to compare stays quiet.
 *
 * @param total - Every record Metriport returned for the category.
 * @param inChartCount - Records the chart already holds.
 * @returns The summary line.
 */
function describeRows(total: number, inChartCount: number): string {
  const records = `${total} ${total === 1 ? 'record' : 'records'}`;
  return inChartCount > 0 ? `${records} \u00b7 ${inChartCount} already in chart` : records;
}

function renderState(row: MetriportImportRow, imported: boolean): JSX.Element {
  if (imported) {
    return (
      <Badge size="sm" color="green" variant="light" leftSection={<IconCheck size={12} />}>
        Imported
      </Badge>
    );
  }
  if (row.inChart) {
    return (
      <Badge size="sm" color="gray" variant="light">
        In chart
      </Badge>
    );
  }
  return (
    <Badge size="sm" color="blue" variant="light">
      Not in chart
    </Badge>
  );
}
