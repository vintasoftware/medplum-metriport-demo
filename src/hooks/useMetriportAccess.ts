// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { useSearchOne } from '@medplum/react';
import { METRIPORT_EMBED_TOKEN_BOT_NAME } from '../utils/metriport';

export interface MetriportAccess {
  /** ID of the embed token bot, needed to execute it. Undefined when it is not deployed. */
  botId?: string;
  /** True when the embed token bot is deployed in this project. */
  hasAccess: boolean;
  /** True while the bot lookup is loading. */
  loading: boolean;
}

/**
 * Hook that determines Metriport access for the current project.
 *
 * Access means the embed token bot is deployed. The bot is found by name, so no Bot ID is
 * hardcoded and the same build works in every project. If the bot is absent, the Metriport route
 * and chart tab never render.
 *
 * @returns Access flags that control route and tab visibility, plus the bot ID to execute.
 */
export function useMetriportAccess(): MetriportAccess {
  const [bot, loading] = useSearchOne('Bot', { name: METRIPORT_EMBED_TOKEN_BOT_NAME });

  // Medplum matches `name` as a prefix, so require an exact match before using the bot.
  const botId = bot?.name === METRIPORT_EMBED_TOKEN_BOT_NAME ? bot.id : undefined;

  return { botId, hasAccess: !!botId, loading };
}
