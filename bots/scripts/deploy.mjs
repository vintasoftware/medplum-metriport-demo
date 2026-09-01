// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/* global console */
/* global process */

/**
 * Deploys the bots in `medplum.config.template.json` to whatever project the Medplum CLI is
 * logged in to.
 *
 * Bot IDs differ per project, so none is committed. Each bot is located by name, created when it
 * is missing, and the resolved ID is written to the generated (git-ignored) `medplum.config.json`
 * that the CLI reads.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const TEMPLATE_PATH = 'medplum.config.template.json';
const CONFIG_PATH = 'medplum.config.json';

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
 * @param name - The bot name.
 * @returns The bot ID, or undefined when no bot with that exact name exists.
 */
function findBotIdByName(name) {
  const bundle = JSON.parse(readMedplum(['get', `Bot?name=${encodeURIComponent(name)}`]));
  // Medplum matches `name` as a prefix, so keep only the exact match.
  return bundle.entry?.map((e) => e.resource).find((bot) => bot.name === name)?.id;
}

const template = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));
const projectId = getProjectId();
const bots = [];

for (const bot of template.bots) {
  let id = findBotIdByName(bot.name);

  if (!id) {
    console.log(`Bot "${bot.name}" not found in project ${projectId}. Creating it.`);
    // `bot create` also appends to medplum.config.json, which is regenerated below.
    runMedplum(['bot', 'create', bot.name, projectId, bot.source, bot.dist]);
    id = findBotIdByName(bot.name);
    if (!id) {
      throw new Error(`Bot "${bot.name}" was created but could not be found by name.`);
    }
  }

  bots.push({ ...bot, id });
}

writeFileSync(CONFIG_PATH, `${JSON.stringify({ bots }, null, 2)}\n`);

for (const bot of bots) {
  console.log(`Deploying ${bot.name} (${bot.id}) to project ${projectId}`);
  runMedplum(['bot', 'deploy', bot.name]);
}
