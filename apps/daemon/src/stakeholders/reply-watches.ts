import { createReplyWatch, type ReplyWatch, type ReplyWatchDeps } from './reply-watch';
import { loadMatchState } from './reply-match-store';
import type { MatchState } from './reply-match';
import type { SlackClients } from './slack-clients';
import { readSlackWorkspaces } from './slack-workspaces';

export interface ReplyWatches {
  /** One watch per signed-in workspace, each checked at once, then every interval on its own timer. */
  start(): void;
  /** Stops every watch and waits for each one's tick in flight. */
  stop(): Promise<void>;
  /** A token was saved: the workspace's watch starts, or waits for its tick in flight, checks again and reads on. */
  reconnect(teamId: string): Promise<void>;
  /** The workspace was disconnected: its watch stops, after its tick in flight. */
  drop(teamId: string): Promise<void>;
}

/** The reply watches of every signed-in workspace; each has its own timer, so a slow or refused one delays no other. */
export function createReplyWatches(
  deps: Omit<ReplyWatchDeps, 'teamId' | 'slack' | 'matched'> & {
    /** Null when TENDB_SLACK=off: no watch runs. */
    readonly slack: SlackClients | null;
  },
): ReplyWatches {
  const { slack: clients, ...base } = deps;
  const watches = new Map<string, ReplyWatch>();
  let matched: MatchState | null = null;
  let stopping = false;

  /** Made on first use and kept by every watch: one reply-match memory for the daemon. */
  function shared(): MatchState {
    matched ??= loadMatchState(deps.state);
    return matched;
  }

  function watchFor(teamId: string): ReplyWatch | null {
    const existing = watches.get(teamId);
    if (existing !== undefined) return existing;
    const client = clients?.clientFor(teamId) ?? null;
    if (client === null) return null;
    const made = createReplyWatch({ ...base, teamId, slack: client, matched: shared() });
    watches.set(teamId, made);
    return made;
  }

  return {
    start() {
      if (clients === null) return;
      for (const workspace of readSlackWorkspaces(deps.state.db))
        watchFor(workspace.teamId)?.start();
    },
    async stop() {
      stopping = true;
      const all = [...watches.values()];
      watches.clear();
      await Promise.all(all.map((w) => w.stop()));
    },
    async reconnect(teamId) {
      if (stopping) return;
      await watchFor(teamId)?.reconnect();
    },
    async drop(teamId) {
      const watch = watches.get(teamId);
      watches.delete(teamId);
      await watch?.stop();
    },
  };
}
