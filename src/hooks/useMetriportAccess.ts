// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { useSearchOne } from '@medplum/react';
import { METRIPORT_EMBED_TOKEN_BOT } from '../utils/metriport';

export interface MetriportAccess {
  /** True when the embed token bot is deployed in this project. */
  hasAccess: boolean;
  /** True while the bot lookup is loading. */
  loading: boolean;
}

/**
 * Hook that determines Metriport access for the current project.
 *
 * Only looks up the bot; if it is not deployed in this project the Metriport route and chart tab
 * never render. The bot itself is executed by identifier, so its ID is never needed here.
 *
 * @returns Access flags that control route and tab visibility.
 */
export function useMetriportAccess(): MetriportAccess {
  const [bot, loading] = useSearchOne('Bot', {
    identifier: `${METRIPORT_EMBED_TOKEN_BOT.system}|${METRIPORT_EMBED_TOKEN_BOT.value}`,
  });

  return { hasAccess: !!bot?.id, loading };
}
