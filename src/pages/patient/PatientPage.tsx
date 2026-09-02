// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Loader, Modal, Paper, ScrollArea } from '@mantine/core';
import { getReferenceString, isOk } from '@medplum/core';
import type { OperationOutcome, ResourceType } from '@medplum/fhirtypes';
import {
  createPharmaciesSection,
  Document,
  getDefaultSections,
  LinkTabs,
  OperationOutcomeAlert,
  PatientSummary,
  useMedplum,
  useResourceModified,
} from '@medplum/react';
import type { JSX } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { usePharmacyDialog } from '../../components/pharmacy/usePharmacyDialog';
import { useDoseSpotAccess } from '../../hooks/useDoseSpotAccess';
import { usePatient } from '../../hooks/usePatient';
import { OrderLabsPage } from '../labs/OrderLabsPage';
import classes from './PatientPage.module.css';
import { getPatientPageTabs, patientPathPrefix } from './PatientPage.utils';

/**
 * Resource types the patient summary reads. A change to any of them, announced through
 * `medplum.notifyResourceModified`, makes the summary stale: it holds the results of one search per
 * section, taken when it mounted.
 */
const SUMMARY_RESOURCE_TYPES: ResourceType[] = [
  'AllergyIntolerance',
  'Condition',
  'Coverage',
  'DiagnosticReport',
  'Goal',
  'Immunization',
  'MedicationRequest',
  'Observation',
  'ServiceRequest',
];

export function PatientPage(): JSX.Element {
  const navigate = useNavigate();
  const medplum = useMedplum();
  const membership = medplum.getProjectMembership();
  const [outcome, setOutcome] = useState<OperationOutcome>();
  const patient = usePatient({ setOutcome });
  const [isLabsModalOpen, setIsLabsModalOpen] = useState(false);
  // Remounts the summary, which is how it re-runs its searches. Importing from Metriport, or any
  // other flow that announces a change, therefore shows up without a page reload.
  const [summaryKey, setSummaryKey] = useState(0);
  useResourceModified(SUMMARY_RESOURCE_TYPES, () => setSummaryKey((key) => key + 1));
  const PharmacyDialogComponent = usePharmacyDialog();
  const { hasAccess: hasDoseSpotAccess } = useDoseSpotAccess();
  const tabs = getPatientPageTabs(membership, { hasDoseSpotAccess });
  const resolvedTabs = useMemo(
    () =>
      tabs.map((t) => ({
        label: t.label,
        value: (t.url ? t.url.replace('%patient.id', patient?.id ?? '') : t.id) || t.id,
      })),
    [patient?.id, tabs]
  );

  const handleCloseLabsModal = useCallback(() => {
    setIsLabsModalOpen(false);
  }, []);

  const sections = useMemo(
    () =>
      getDefaultSections(() => setIsLabsModalOpen(true)).map((s) =>
        s.key === 'pharmacies' ? createPharmaciesSection(PharmacyDialogComponent) : s
      ),
    [setIsLabsModalOpen, PharmacyDialogComponent]
  );

  if (outcome && !isOk(outcome)) {
    return (
      <Document>
        <OperationOutcomeAlert outcome={outcome} />
      </Document>
    );
  }

  const patientId = patient?.id;
  if (!patientId) {
    return (
      <Document>
        <Loader />
      </Document>
    );
  }

  return (
    <>
      <div key={getReferenceString(patient)} className={classes.container}>
        <div className={classes.sidebar}>
          <ScrollArea className={classes.scrollArea}>
            <PatientSummary
              key={summaryKey}
              patient={patient}
              onClickResource={(resource) =>
                navigate(`/Patient/${patientId}/${resource.resourceType}/${resource.id}`)?.catch(console.error)
              }
              sections={sections}
            />
          </ScrollArea>
        </div>

        <div className={classes.content}>
          <Paper w="100%" radius={0} style={{ borderBottom: '1px solid var(--app-shell-border-color)' }}>
            <ScrollArea>
              <LinkTabs
                baseUrl={patientPathPrefix(patientId)}
                tabs={resolvedTabs}
                variant="unstyled"
                className="pill-tabs"
                p="sm"
              />
            </ScrollArea>
          </Paper>
          <div className={classes.contentBody}>
            <Outlet />
          </div>
        </div>
      </div>
      <Modal opened={isLabsModalOpen} onClose={handleCloseLabsModal} size="xl" centered title="Order Labs">
        <OrderLabsPage onSubmitLabOrder={handleCloseLabsModal} />
      </Modal>
    </>
  );
}
