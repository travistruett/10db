import {
  EventType,
  SlackWorkspaceState,
  type SlackStatusDto,
  type SlackWorkspaceStatusDto,
} from '@10db/contracts';
import type { StateStore } from '../events';
import type { SlackIdentity } from '../slack';
import { readSlackWorkspaces } from './slack-workspaces';

export interface SlackConnections {
  readonly off: boolean;
  /** Every signed-in workspace with its state, in stored order; a workspace never checked reads `checking`. */
  list(): SlackStatusDto;
  get(teamId: string): SlackWorkspaceStatusDto | null;
  /** A no-op for a team not in `slack.workspaces`; an event goes out only when the state changes. */
  set(
    teamId: string,
    state: SlackWorkspaceState,
    detail?: {
      readonly identity?: SlackIdentity;
      readonly error?: string | null;
      readonly at?: string;
    },
  ): void;
  drop(teamId: string): void;
  connectedTeams(): string[];
}

interface Found {
  readonly state: SlackWorkspaceState;
  readonly botUserId: string | null;
  readonly botName: string | null;
  readonly checkedAt: string;
  readonly error: string | null;
}

/**
 * Where each workspace's Slack connection stands, as its reply watch last found it: `connected`, `refused`
 * (Slack turned the token down), `none` (the token is gone), `unreachable` (three ticks in a row failed), or
 * `checking` until the first check. Every state but `connected` counts as an outage for the Inbox.
 */
export function createSlackConnections(deps: {
  readonly state: StateStore;
  readonly off: boolean;
}): SlackConnections {
  const found = new Map<string, Found>();

  function get(teamId: string): SlackWorkspaceStatusDto | null {
    const workspace = readSlackWorkspaces(deps.state.db).find((w) => w.teamId === teamId);
    if (workspace === undefined) return null;
    const last = found.get(teamId);
    return {
      teamId,
      teamName: workspace.teamName,
      botUserId: workspace.botUserId ?? last?.botUserId ?? null,
      botName: workspace.botName ?? last?.botName ?? null,
      state: last?.state ?? SlackWorkspaceState.Checking,
      checkedAt: last?.checkedAt ?? null,
      error: last?.error ?? null,
    };
  }

  return {
    off: deps.off,
    list: () => ({
      off: deps.off,
      workspaces: readSlackWorkspaces(deps.state.db).flatMap((w) => get(w.teamId) ?? []),
    }),
    get,
    set(teamId, next, detail = {}) {
      if (get(teamId) === null) return;
      const before = found.get(teamId)?.state ?? SlackWorkspaceState.Checking;
      const last = found.get(teamId);
      found.set(teamId, {
        state: next,
        botUserId: detail.identity?.botUserId ?? last?.botUserId ?? null,
        botName: detail.identity?.botName ?? last?.botName ?? null,
        checkedAt: detail.at ?? deps.state.now(),
        error: detail.error ?? null,
      });
      if (next !== before)
        deps.state.write((ctx) => {
          ctx.emit({
            type: EventType.SlackConnectionChanged,
            entityType: 'slack',
            entityId: teamId,
            data: { state: next },
          });
        });
    },
    drop(teamId) {
      found.delete(teamId);
    },
    connectedTeams: () =>
      readSlackWorkspaces(deps.state.db)
        .filter((w) => found.get(w.teamId)?.state === SlackWorkspaceState.Connected)
        .map((w) => w.teamId),
  };
}
