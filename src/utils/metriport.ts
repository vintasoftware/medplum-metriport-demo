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
async function createMetriportEmbedSession(medplum: MedplumClient, patientId: string): Promise<MetriportEmbedSession> {
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
export type MetriportLinkResult =
  { status: 'linked'; metriportPatientId: string; created: boolean } | { status: 'no-match' };

/**
 * Links a patient chart to a Metriport patient.
 *
 * Matching sends demographics to Metriport, so this only runs when a provider asks for it.
 *
 * The bot creates the patient in Metriport when no match is found, so the chart always ends up with
 * a Metriport record when the demographics allow one.
 *
 * @param medplum - The Medplum client.
 * @param patientId - The Medplum Patient ID whose chart is open.
 * @returns The link result.
 */
async function linkMetriportPatient(medplum: MedplumClient, patientId: string): Promise<MetriportLinkResult> {
  return medplum.executeBot(METRIPORT_LINK_PATIENT_BOT, { patientId, create: true }, 'application/json');
}

/**
 * Opens the Metriport session for a patient chart, linking the patient on first view.
 *
 * Two bots are involved: the embed token bot reports whether the chart is linked, and the link
 * patient bot links it. An already linked chart costs one call.
 *
 * @param medplum - The Medplum client.
 * @param patientId - The Medplum Patient ID whose chart is open.
 * @param onLinkStart - Called when linking begins, so the caller can report the wait.
 * @returns The embed session. Still `not-linked` when linking was impossible.
 */
export async function openMetriportSession(
  medplum: MedplumClient,
  patientId: string,
  onLinkStart?: () => void
): Promise<MetriportEmbedSession> {
  const session = await createMetriportEmbedSession(medplum, patientId);
  if (session.status !== 'not-linked') {
    return session;
  }

  onLinkStart?.();
  const link = await linkMetriportPatient(medplum, patientId);

  // A rejected request throws, so the caller reports Metriport's reason. Any other non-link result
  // leaves the chart unlinked.
  if (link.status !== 'linked') {
    return session;
  }

  return createMetriportEmbedSession(medplum, patientId);
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
