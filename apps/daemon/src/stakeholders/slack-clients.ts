import type { Clock } from '../clock';
import { slackBotAccount, type Keychain } from '../environment';
import type { StateStore } from '../events';
import { createSlackClient, type SlackClient } from '../slack';
import { readSlackWorkspaces } from './slack-workspaces';

export interface SlackClients {
  /** The client of a signed-in workspace, reading its token at each call; null for a null team or one not signed in. */
  clientFor(teamId: string | null): SlackClient | null;
}

/** One Slack client per signed-in workspace, made on first use and kept; each reads its own Keychain item per call. */
export function createSlackClients(deps: {
  readonly state: StateStore;
  readonly keychain: Keychain;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly timeoutMs: number;
}): SlackClients {
  const made = new Map<string, SlackClient>();
  return {
    clientFor(teamId) {
      if (teamId === null) return null;
      if (!readSlackWorkspaces(deps.state.db).some((w) => w.teamId === teamId)) return null;
      let client = made.get(teamId);
      if (client === undefined) {
        client = createSlackClient({
          fetch: deps.fetch,
          token: () => deps.keychain.readAsync(slackBotAccount(teamId)),
          clock: deps.clock,
          timeoutMs: deps.timeoutMs,
        });
        made.set(teamId, client);
      }
      return client;
    },
  };
}
