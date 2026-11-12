import { EventType, type SlackConnectionDto } from '@10db/contracts';
import type { StateStore } from '../events';

type ConnectionState = SlackConnectionDto['state'];

export interface SlackConnection {
  get(): SlackConnectionDto;
  /** Records where the connection stands; an event goes out only when the state changes. */
  set(
    state: ConnectionState,
    detail?: {
      readonly identity?: { teamId: string; teamName: string; botUserId: string };
      readonly error?: string | null;
      readonly at?: string;
    },
  ): void;
}

/**
 * Where the Slack connection stands, as the reply watch last found it: `connected`, `refused` (Slack turned
 * the token down), `none` (the token is gone), `unreachable` (three ticks in a row failed) or `off`.
 * Every state but `connected` counts as an outage for the Inbox.
 */
export function createSlackConnection(deps: {
  readonly state: StateStore;
  readonly initial?: ConnectionState;
}): SlackConnection {
  let current: SlackConnectionDto = {
    state: deps.initial ?? 'connected',
    teamId: null,
    teamName: null,
    botUserId: null,
    checkedAt: null,
    error: null,
  };
  return {
    get: () => current,
    set(next, detail = {}) {
      const changed = next !== current.state;
      current = {
        state: next,
        teamId: detail.identity?.teamId ?? current.teamId,
        teamName: detail.identity?.teamName ?? current.teamName,
        botUserId: detail.identity?.botUserId ?? current.botUserId,
        checkedAt: detail.at ?? deps.state.now(),
        error: detail.error ?? null,
      };
      if (changed)
        deps.state.write((ctx) => {
          ctx.emit({
            type: EventType.SlackConnectionChanged,
            entityType: 'slack',
            entityId: 'connection',
            data: { state: next },
          });
        });
    },
  };
}
