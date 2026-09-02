// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { MetriportConsolidatedResult } from '../../utils/metriport';
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
 * What Metriport answered is remembered for as long as the view is open, so going back to the
 * category list and opening a category again, or moving the date range back to one already read, is
 * instant instead of another bot execution. The chart is always read again: it is a fraction of the
 * cost, and it is what decides whether a row shows as already in the chart, which an import changes.
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

  // Metriport reads already asked for, by date range and category. A ref rather than a module cache:
  // it lives exactly as long as the view, so closing the tab drops the records rather than keeping
  // them for a patient nobody is looking at.
  //
  // The promise is held, not the result, so a read still in flight is joined rather than started
  // again — which is also what stops React's development double render from executing every bot
  // twice. A failed read is dropped, because the retry it offers has to reach Metriport.
  const generation = `${patientId}|${reloadKey}`;
  const cacheRef = useRef(new Map<string, Promise<MetriportConsolidatedResult>>());
  const cacheGenerationRef = useRef(generation);
  if (cacheGenerationRef.current !== generation) {
    // A different patient, or a refresh asking Metriport again. Either way nothing held here still
    // answers the question being asked.
    cacheGenerationRef.current = generation;
    cacheRef.current = new Map();
  }

  const readCached = useCallback(
    (key: string, read: () => Promise<MetriportConsolidatedResult>): Promise<MetriportConsolidatedResult> => {
      const cache = cacheRef.current;
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }
      const pending = read().catch((err: unknown) => {
        if (cache.get(key) === pending) {
          cache.delete(key);
        }
        throw err;
      });
      cache.set(key, pending);
      return pending;
    },
    []
  );

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

    readCached(`count|${dateFrom ?? 'all'}`, () => getMetriportCounts(medplum, patientId, dateFrom))
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
  }, [medplum, patientId, dateFrom, reloadKey, readCached]);

  useEffect(() => {
    if (!openCategoryEntry) {
      setCategory(undefined);
      return undefined;
    }

    let cancelled = false;
    setCategory({ status: 'loading', category: openCategoryEntry });

    Promise.all([
      readCached(`fetch|${openCategoryEntry.id}|${dateFrom ?? 'all'}`, () =>
        getMetriportRecords(medplum, patientId, [...openCategoryEntry.resourceTypes], dateFrom)
      ),
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
  }, [medplum, patientId, dateFrom, reloadKey, openCategoryEntry, readCached]);

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
