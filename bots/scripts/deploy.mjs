// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/* global console */
/* global process */

/**
 * Deploys the bots in `medplum.config.template.json` to whatever project the Medplum CLI is
 * logged in to.
 *
 * Bot IDs differ per project, so none is committed. Each bot is located by the identifier the app
 * executes it with, created when it is missing, and the resolved ID is written to the generated
 * (git-ignored) `medplum.config.json` that the CLI reads.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const TEMPLATE_PATH = 'medplum.config.template.json';
const CONFIG_PATH = 'medplum.config.json';

// Must match METRIPORT_INTEGRATION_SYSTEM in src/utils/metriport.ts, which is how the app
// addresses these bots.
const IDENTIFIER_SYSTEM = 'https://medplum.com/integrations/metriport';

/** Runs the Medplum CLI and streams its output to the terminal. */
function runMedplum(args) {
  execFileSync('npx', ['medplum', ...args], { stdio: 'inherit' });
}

/** Runs the Medplum CLI and returns its stdout. */
function readMedplum(args) {
  return execFileSync('npx', ['medplum', ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
}

/**
 * @returns The project ID the CLI is currently logged in to.
 */
function getProjectId() {
  const whoami = readMedplum(['whoami']);
  const match = whoami.match(/Project\/([0-9a-f-]+)/);
  if (!match) {
    throw new Error(`Could not read the project from "medplum whoami". Run "npx medplum login" first.\n${whoami}`);
  }
  return match[1];
}

/**
 * @param query - A FHIR search string, for example `Bot?identifier=system|value`.
 * @returns The first matching resource, or undefined.
 */
function searchOne(query) {
  const bundle = JSON.parse(readMedplum(['get', query]));
  return bundle.entry?.[0]?.resource;
}

/**
 * Finds the bot by the identifier the app addresses it with.
 *
 * @param name - The bot name, which is also its identifier value.
 * @returns The bot resource, or undefined when it is not deployed here.
 */
function findBot(name) {
  return searchOne(`Bot?identifier=${encodeURIComponent(`${IDENTIFIER_SYSTEM}|${name}`)}`);
}

/**
 * Creates the bot and returns its new ID, read from the CLI output rather than a follow-up search:
 * a fresh bot carries no identifier yet, so it cannot be found by one.
 *
 * @param entry - The template entry.
 * @param projectId - The project to create the bot in.
 * @returns The new bot ID.
 */
function createBot(entry, projectId) {
  const output = readMedplum(['bot', 'create', entry.name, projectId, entry.source, entry.dist]);
  process.stdout.write(output);

  const match = output.match(/Bot created:\s*([0-9a-f-]+)/i);
  if (!match) {
    throw new Error(`Could not read the new bot ID from the CLI output:\n${output}`);
  }
  return match[1];
}

/**
 * Adds the integration identifier when the bot does not already carry it, keeping any others.
 *
 * @param bot - The bot resource.
 * @param name - The identifier value, which is the bot name.
 */
function ensureIdentifier(bot, name) {
  const identifier = { system: IDENTIFIER_SYSTEM, value: name };
  const present = bot.identifier?.some((id) => id.system === identifier.system && id.value === identifier.value);
  if (present) {
    return;
  }

  console.log(`Stamping ${IDENTIFIER_SYSTEM}|${name} onto Bot/${bot.id}`);
  const patch = bot.identifier
    ? [{ op: 'add', path: '/identifier/-', value: identifier }]
    : [{ op: 'add', path: '/identifier', value: [identifier] }];
  runMedplum(['patch', `Bot/${bot.id}`, JSON.stringify(patch)]);
}

/**
 * Raises the bot's execution time limit when the template asks for one.
 *
 * A bot that calls a slow third-party API needs more than the Medplum default of 10 seconds. The
 * server caps this, so a value above the project maximum is refused rather than silently applied.
 *
 * @param bot - The bot resource.
 * @param timeout - The maximum execution time in seconds, or undefined to leave it alone.
 */
function ensureTimeout(bot, timeout) {
  if (!timeout || bot.timeout === timeout) {
    return;
  }

  console.log(`Setting timeout ${timeout}s on Bot/${bot.id}`);
  runMedplum(['patch', `Bot/${bot.id}`, JSON.stringify([{ op: 'add', path: '/timeout', value: timeout }])]);
}

const template = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));
const projectId = getProjectId();
const bots = [];

for (const entry of template.bots) {
  let bot = findBot(entry.name);

  if (!bot) {
    console.log(`Bot "${entry.name}" not found in project ${projectId}. Creating it.`);
    // `bot create` also appends to medplum.config.json, which is regenerated below.
    bot = { id: createBot(entry, projectId) };
  }

  ensureIdentifier(bot, entry.name);
  ensureTimeout(bot, entry.timeout);
  // `timeout` is ours, not the CLI's: it belongs on the Bot resource, not in the deploy config.
  const { timeout, ...deployEntry } = entry;
  bots.push({ ...deployEntry, id: bot.id });
}

writeFileSync(CONFIG_PATH, `${JSON.stringify({ bots }, null, 2)}\n`);

for (const bot of bots) {
  console.log(`Deploying ${bot.name} (${bot.id}) to project ${projectId}`);
  runMedplum(['bot', 'deploy', bot.name]);
}
