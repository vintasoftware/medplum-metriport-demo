// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { describeBotError, getMetriportCounts, getMetriportRecords } from '../../utils/metriport';
import { showErrorNotification, showSuccessNotification } from '../../utils/notifications';
import { buildMetriportImportBundle } from './MetriportImportPanel.bundle';
import type { MetriportImportCategory, MetriportImportRow } from './MetriportImportPanel.utils';
import { buildImportRows, getDateFrom, loadChartKeys, METRIPORT_IMPORT_CATEGORIES } from './MetriportImportPanel.utils';

/** What the open category is doing. Nothing else can be true at the same time. */
export type MetriportCategoryState =
  | { readonly status: 'loading'; readonly category: MetriportImportCategory }
  | { readonly status: 'error'; readonly category: MetriportImportCategory; readonly message: string }
  | {
      readonly status: 'ready';
      readonly category: MetriportImportCategory;
      readonly bundle: Bundle;
      readonly rows: MetriportImportRow[];
    };

export interface UseMetriportImport {
  /** Records Metriport holds, per resource type. Undefined while loading. */
  readonly counts?: Record<string, number>;
  readonly countsError?: string;
  /** The open category, or undefined when the category list is showing. */
  readonly category?: MetriportCategoryState;
  readonly selectedKeys: ReadonlySet<string>;
  readonly importedKeys: ReadonlySet<string>;
  readonly importing: boolean;
  readonly openCategory: (id: string | undefined) => void;
  readonly toggle: (key: string, checked: boolean) => void;
  readonly toggleMany: (keys: string[], checked: boolean) => void;
  readonly importRecords: (keys: string[]) => void;
}

/**
 * Reads a patient's records from Metriport and imports the ones a provider ticks.
 *
 * Every read runs twice over: the counts for the category list, and the records for whichever
 * category is open — which is the `category` search parameter, so a refresh or a shared link lands
 * in the same place. Each read cancels only itself, so opening a category cannot discard the counts.
 *
 * @param patientId - The Medplum Patient whose chart is open.
 * @param range - A value from DATE_RANGE_OPTIONS.
 * @param reloadKey - Changes to read Metriport again.
 * @returns The state the panel renders, and the actions it offers.
 */
export function useMetriportImport(patientId: string, range: string, reloadKey: number): UseMetriportImport {
  const medplum = useMedplum();
  const [searchParams, setSearchParams] = useSearchParams();
  const categoryId = searchParams.get('category') ?? undefined;

  const [counts, setCounts] = useState<Record<string, number>>();
  const [countsError, setCountsError] = useState<string>();
  const [category, setCategory] = useState<MetriportCategoryState>();
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [importedKeys, setImportedKeys] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const dateFrom = getDateFrom(range);
  const openCategoryEntry = METRIPORT_IMPORT_CATEGORIES.find((entry) => entry.id === categoryId);

  const openCategory = useCallback(
    (id: string | undefined): void => {
      setSearchParams(
        (params) => {
          const updated = new URLSearchParams(params);
          if (id) {
            updated.set('category', id);
          } else {
            updated.delete('category');
          }
          return updated;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  useEffect(() => {
    let cancelled = false;
    setCounts(undefined);
    setCountsError(undefined);

    getMetriportCounts(medplum, patientId, dateFrom)
      .then((result) => {
        if (!cancelled) {
          setCounts(result.status === 'counts' ? result.resources : {});
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setCountsError(describeBotError(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [medplum, patientId, dateFrom, reloadKey]);

  useEffect(() => {
    if (!openCategoryEntry) {
      setCategory(undefined);
      return undefined;
    }

    let cancelled = false;
    setCategory({ status: 'loading', category: openCategoryEntry });

    Promise.all([
      getMetriportRecords(medplum, patientId, [...openCategoryEntry.resourceTypes], dateFrom),
      loadChartKeys(medplum, openCategoryEntry.resourceTypes, patientId),
    ])
      .then(([result, chartKeys]) => {
        if (cancelled) {
          return;
        }
        if (result.status === 'too-many') {
          setCategory({
            status: 'error',
            category: openCategoryEntry,
            message: `Metriport returned ${result.count.toLocaleString()} records, more than the ${result.limit.toLocaleString()} this view can list. Narrow the date range.`,
          });
          return;
        }

        const bundle = result.status === 'bundle' ? result.bundle : EMPTY_BUNDLE;
        // The bundle also carries the support resources Metriport hydrated into it. Only the
        // category's own types become rows; the rest ride along with an import.
        const resources = (bundle.entry ?? [])
          .map((entry) => entry.resource)
          .filter((resource): resource is Resource =>
            openCategoryEntry.resourceTypes.some((type) => type === resource?.resourceType)
          );
        setCategory({
          status: 'ready',
          category: openCategoryEntry,
          bundle,
          rows: buildImportRows({ resources, bundle, chartKeys, patientId }),
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setCategory({ status: 'error', category: openCategoryEntry, message: describeBotError(err) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [medplum, patientId, dateFrom, reloadKey, openCategoryEntry]);

  const importRecords = useCallback(
    (keys: string[]): void => {
      if (category?.status !== 'ready') {
        return;
      }
      const records = category.rows.filter((row) => keys.includes(row.key));
      if (records.length === 0) {
        return;
      }

      setImporting(true);
      const bundle = category.bundle;
      medplum
        .executeBatch(buildMetriportImportBundle(bundle, records, patientId))
        .then((response) => {
          const failed = (response.entry ?? []).filter((entry) => !entry.response?.status?.startsWith('2')).length;

          // Tell the rest of the chart what changed. This drops the client's cached searches for
          // those types and wakes anything listening through useResourceModified, so the patient
          // summary shows the imported records without a reload.
          for (const resourceType of new Set(records.map((row) => row.resource.resourceType))) {
            medplum.notifyResourceModified({ resourceType, operation: 'create' });
          }

          setImportedKeys((prev) => new Set([...prev, ...keys]));
          setSelectedKeys((prev) => new Set([...prev].filter((key) => !keys.includes(key))));

          if (failed > 0) {
            // Statuses only. An OperationOutcome from a rejected write can carry record content.
            showErrorNotification(new Error(`${failed} of ${response.entry?.length ?? 0} entries were not written`));
          } else {
            showSuccessNotification({
              title: 'Imported',
              message: `${records.length} record${records.length === 1 ? '' : 's'} added to the chart`,
            });
          }
        })
        .catch(showErrorNotification)
        .finally(() => setImporting(false));
    },
    [category, medplum, patientId]
  );

  const toggle = useCallback((key: string, checked: boolean): void => {
    setSelectedKeys((prev) => toggleKeys(prev, [key], checked));
  }, []);

  const toggleMany = useCallback((keys: string[], checked: boolean): void => {
    setSelectedKeys((prev) => toggleKeys(prev, keys, checked));
  }, []);

  return {
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
  };
}

const EMPTY_BUNDLE: Bundle = { resourceType: 'Bundle', type: 'searchset' };

function toggleKeys(current: ReadonlySet<string>, keys: string[], checked: boolean): ReadonlySet<string> {
  const next = new Set(current);
  for (const key of keys) {
    if (checked) {
      next.add(key);
    } else {
      next.delete(key);
    }
  }
  return next;
}
