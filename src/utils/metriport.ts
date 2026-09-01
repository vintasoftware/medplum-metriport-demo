// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { normalizeErrorString } from '@medplum/core';
import type { Identifier } from '@medplum/fhirtypes';

// Identifier system shared by the deployed Metriport integration bots. Bots are addressed by
// identifier, so no Bot ID is hardcoded and the same build works in every project. The deploy
// script stamps these onto the Bot resources.
export const METRIPORT_INTEGRATION_SYSTEM = 'https://medplum.com/integrations/metriport';

// Bot that creates a short-lived Metriport embed token for one patient. The Metriport API key lives
// in the bot secrets, so it never reaches the browser. See bots/src/metriportEmbedToken.ts.
export const METRIPORT_EMBED_TOKEN_BOT: Identifier = {
  system: METRIPORT_INTEGRATION_SYSTEM,
  value: 'metriport-embed-token',
};

// Bot that matches or creates the Metriport patient and stores the ID on the Medplum Patient.
// See bots/src/metriportLinkPatient.ts.
export const METRIPORT_LINK_PATIENT_BOT: Identifier = {
  system: METRIPORT_INTEGRATION_SYSTEM,
  value: 'metriport-link-patient',
};

/** Mirrors the bot response in bots/src/metriportEmbedToken.ts. */
export type MetriportEmbedSession =
  | {
      status: 'ok';
      token: string;
      embedBaseUrl: string;
      metriportPatientId: string;
      environment: 'sandbox' | 'production';
      expiresInSeconds: number;
    }
  | { status: 'not-linked' };

/**
 * Creates a Metriport embed session for a patient chart.
 *
 * @param medplum - The Medplum client.
 * @param patientId - The Medplum Patient ID whose chart is open.
 * @returns The embed session, or a not-linked result when the patient has no Metriport identifier.
 */
export async function getMetriportSession(medplum: MedplumClient, patientId: string): Promise<MetriportEmbedSession> {
  return medplum.executeBot(METRIPORT_EMBED_TOKEN_BOT, { patientId }, 'application/json');
}

/**
 * Builds the Metriport embedded patient view URL.
 *
 * The token goes in the URL fragment, as the Metriport docs require, so it is never sent to a
 * server as a query parameter.
 *
 * @param session - An `ok` embed session returned by the bot.
 * @returns The URL to load in the iframe.
 * @see https://docs.metriport.com/medical-api/getting-started/embedding
 */
export function buildMetriportPatientEmbedUrl(session: Extract<MetriportEmbedSession, { status: 'ok' }>): string {
  const patientPath = encodeURIComponent(session.metriportPatientId);
  return `${session.embedBaseUrl}/patient/${patientPath}#access_token=${session.token}`;
}

/** Mirrors the bot response in bots/src/metriportLinkPatient.ts. */
export type MetriportLinkResult = { status: 'linked'; metriportPatientId: string } | { status: 'no-match' };

/**
 * Connects a patient chart to Metriport and starts a network query.
 *
 * The bot matches the patient in Metriport, creates them when there is no match, stores the ID on
 * the Patient, and asks Metriport to search the health data networks for their records. All of that
 * discloses demographics to Metriport, so it only runs when a provider asks for it.
 *
 * @param medplum - The Medplum client.
 * @param patientId - The Medplum Patient ID whose chart is open.
 * @returns The link result.
 */
export async function linkMetriportPatient(medplum: MedplumClient, patientId: string): Promise<MetriportLinkResult> {
  return medplum.executeBot(METRIPORT_LINK_PATIENT_BOT, { patientId, create: true }, 'application/json');
}

/**
 * Turns a bot failure into one readable line.
 *
 * A Medplum bot error arrives as JSON carrying `errorMessage` and a stack `trace`. Rendering that
 * raw puts a Node stack in the chart, so only the message is kept.
 *
 * @param err - The rejected value from a bot call.
 * @returns A single-line message.
 */
export function describeBotError(err: unknown): string {
  const text = normalizeErrorString(err);
  try {
    const parsed = JSON.parse(text) as { errorMessage?: string };
    return parsed.errorMessage ?? text;
  } catch {
    return text;
  }
}
