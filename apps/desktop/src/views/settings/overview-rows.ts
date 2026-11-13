import {
  AgentCopyState,
  CatalogueAttempt,
  CatalogueSource,
  type AccountDto,
  type AgentCopy,
  type BenchmarkStatusDto,
  type CatalogueStatusDto,
  type GithubStatusDto,
  type SelfUpdateStatusDto,
  type SlackConnectionDto,
} from '@10db/contracts';
import { shortAgo } from '../factory/short-ago';
import { fromNow } from '../../shell/relative';
import { ACCOUNT_KIND_LABEL } from './account-kind-label';
import { AccountStatus, ACCOUNT_STATUS_LABEL, accountStatus } from './accounts/account-status';
import { ConnectionTone } from './connection-status';
import type { SettingsSectionKey } from './sections';

export const OverviewGroup = {
  Access: 'access',
  Services: 'services',
  Data: 'data',
} as const;
export type OverviewGroup = (typeof OverviewGroup)[keyof typeof OverviewGroup];

/** Which service or provider mark a row shows; the row view maps each to an icon. */
export type RowMark =
  | 'key'
  | 'claude'
  | 'openai'
  | 'aws'
  | 'github'
  | 'slack'
  | 'gauge'
  | 'database'
  | 'terminal'
  | 'refresh';

/** What a row says once its query has answered, or that it hasn't, or that the read failed. */
export type RowState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'ready';
      readonly tone: ConnectionTone;
      readonly label: string;
      /** The dimmed second line; null when the state line says it all. */
      readonly detail: string | null;
    };

export interface OverviewRow {
  /** Names the row for `?focus=`. */
  readonly id: string;
  readonly name: string;
  readonly group: OverviewGroup;
  readonly mark: RowMark;
  /** Where the row's link goes: the section that fixes it, and the card in it. */
  readonly link: { readonly section: SettingsSectionKey; readonly focus: string | null };
  readonly state: RowState;
  /** Reads the row's query again; null for a row that is not a failed read. */
  readonly retry: (() => void) | null;
}

const ready = (tone: ConnectionTone, label: string, detail: string | null = null): RowState => ({
  kind: 'ready',
  tone,
  label,
  detail,
});

/** An account's state is the badge Accounts shows: ready works, anything missing needs the builder. */
export function accountState(account: AccountDto): RowState {
  const status = accountStatus(account);
  const kind = ACCOUNT_KIND_LABEL[account.kind];
  if (status === AccountStatus.Ready) return ready(ConnectionTone.Works, 'Ready', kind);
  return ready(ConnectionTone.NeedsYou, ACCOUNT_STATUS_LABEL[status], kind);
}

const GITHUB_WITHOUT =
  'Pull requests, CI checks and self-update stop; projects can still commit directly.';

export function githubState(status: GithubStatusDto): RowState {
  switch (status.state) {
    case 'signed_in':
      return ready(ConnectionTone.Works, `Signed in as ${status.login ?? 'GitHub'}`);
    case 'signed_out':
      return ready(
        ConnectionTone.NeedsYou,
        status.signingIn === null ? 'Not signed in' : 'Signing in, waiting for you to approve',
        GITHUB_WITHOUT,
      );
    case 'not_installed':
      return ready(ConnectionTone.NeedsYou, "gh isn't installed", GITHUB_WITHOUT);
    case 'unreachable':
      return ready(ConnectionTone.NeedsYou, "Couldn't reach GitHub", GITHUB_WITHOUT);
  }
}

const SLACK_WITHOUT = 'Questions for other people stay in your Inbox; nothing is sent.';

export function slackState(connection: SlackConnectionDto): RowState {
  switch (connection.state) {
    case 'connected':
      return ready(ConnectionTone.Works, `${connection.teamName ?? 'Slack'} · posts as @10db`);
    case 'none':
      return ready(ConnectionTone.NeedsYou, 'Not connected', SLACK_WITHOUT);
    case 'refused':
      return ready(ConnectionTone.NeedsYou, 'Token refused', SLACK_WITHOUT);
    case 'unreachable':
      return ready(ConnectionTone.NeedsYou, "Can't be reached", SLACK_WITHOUT);
    case 'off':
      return ready(ConnectionTone.Off, 'Off: 10db was started with TENDB_SLACK=off');
  }
}

const AA_WITHOUT =
  "Models are compared without scores: each role takes its tier's model at its default effort.";
const LAST_GOOD = 'Routing uses the last good scores.';

export function benchmarkState(status: BenchmarkStatusDto, now: number): RowState {
  if (status.off)
    return ready(ConnectionTone.Off, 'Off: 10db was started with TENDB_BENCHMARKS=off');
  if (!status.keyConfigured) return ready(ConnectionTone.NeedsYou, 'No key', AA_WITHOUT);
  // A sync under way says nothing yet about the key, so the row is neither works nor needs you.
  if (status.syncing) return ready(ConnectionTone.Off, 'Checking the key…');
  if (status.outcome === 'unauthorized')
    return ready(ConnectionTone.NeedsYou, 'AA refused this key', AA_WITHOUT);
  const label =
    status.lastSuccessAt === null
      ? 'Key set'
      : `Key set · synced ${shortAgo(status.lastSuccessAt, now)} · ${String(status.models)} models`;
  const keep = status.lastSuccessAt === null ? '' : ` ${LAST_GOOD}`;
  if (status.outcome === 'rate_limited')
    return ready(ConnectionTone.Works, label, `Rate limited, retrying.${keep}`);
  if (status.outcome === 'failed')
    return ready(
      ConnectionTone.Works,
      label,
      `Sync failed: ${status.message ?? 'unknown error'}.${keep}`,
    );
  return ready(ConnectionTone.Works, label);
}

export function catalogueState(status: CatalogueStatusDto, now: number): RowState {
  if (status.lastAttempt === CatalogueAttempt.Off)
    return ready(ConnectionTone.Off, 'Off: 10db was started with TENDB_CATALOGUE=off');
  const failed = status.lastAttempt === CatalogueAttempt.Failed;
  const models = `${String(status.models)} models`;
  switch (status.source) {
    case CatalogueSource.None:
      return ready(
        ConnectionTone.NeedsYou,
        failed ? "Couldn't reach models.dev" : 'No catalogue yet',
      );
    case CatalogueSource.Snapshot:
      return failed
        ? ready(
            ConnectionTone.NeedsYou,
            "Couldn't reach models.dev",
            `Showing the copy built into this release, ${models}.`,
          )
        : ready(ConnectionTone.Works, `${models} · the copy built into this release`);
    case CatalogueSource.Fetched:
    case CatalogueSource.Stored: {
      const age =
        status.fetchedAt === null ? 'an unknown time ago' : fromNow(status.fetchedAt, now);
      return failed
        ? ready(
            ConnectionTone.NeedsYou,
            "Couldn't reach models.dev",
            `Showing the copy from ${age}, ${models}.`,
          )
        : ready(ConnectionTone.Works, `${models} · fetched ${age}`);
    }
  }
}

/** One pinned agent CLI: a copy being downloaded clears by itself, so it is not the builder's. */
export function agentState(agent: AgentCopy): RowState {
  switch (agent.state) {
    case AgentCopyState.Ready:
      return ready(ConnectionTone.Works, `${agent.pinned} · ready`);
    case AgentCopyState.Fetching:
      return ready(ConnectionTone.Off, `${agent.pinned} · downloading`);
    case AgentCopyState.Refused:
      return ready(ConnectionTone.NeedsYou, `${agent.pinned} · refused`, agent.problem);
  }
}

const SHORT_COMMIT = 7;

export function selfUpdateState(
  status: Pick<SelfUpdateStatusDto, 'enabled' | 'runningCommit' | 'availableCommit' | 'blocker'>,
): RowState {
  const blocker = status.blocker;
  if (blocker?.kind === 'source')
    return ready(ConnectionTone.Off, 'Runs from source, never updates itself');
  if (!status.enabled) return ready(ConnectionTone.Off, 'Off: you turned it off in Updates');
  if (blocker) {
    switch (blocker.kind) {
      case 'no-repository':
        return ready(ConnectionTone.Off, 'No repository to follow', blocker.message);
      case 'not-in-applications':
        return ready(ConnectionTone.Off, 'Not the copy in /Applications', blocker.message);
      case 'gh-missing':
        return ready(ConnectionTone.NeedsYou, "gh isn't installed", blocker.message);
      case 'unreachable':
        return ready(ConnectionTone.NeedsYou, "Can't see new builds", blocker.message);
      case 'failed':
        return ready(ConnectionTone.NeedsYou, 'The last update failed', blocker.message);
    }
  }
  const running = (status.runningCommit ?? '').slice(0, SHORT_COMMIT);
  const next = status.availableCommit?.slice(0, SHORT_COMMIT);
  return ready(
    ConnectionTone.Works,
    next === undefined ? `Running ${running}` : `Running ${running} · ${next} is next`,
  );
}

const needsBuilder = (row: OverviewRow): boolean =>
  row.state.kind === 'failed' ||
  (row.state.kind === 'ready' && row.state.tone === ConnectionTone.NeedsYou);

const GROUP_ORDER: readonly OverviewGroup[] = [
  OverviewGroup.Access,
  OverviewGroup.Services,
  OverviewGroup.Data,
];

/** Rows grouped in the page's order, those that need the builder first within each group. */
export function sortRows(rows: readonly OverviewRow[]): OverviewRow[] {
  return GROUP_ORDER.flatMap((group) => {
    const inGroup = rows.filter((row) => row.group === group);
    return [...inGroup.filter(needsBuilder), ...inGroup.filter((row) => !needsBuilder(row))];
  });
}

export type Summary =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly count: number }
  | {
      readonly kind: 'needs';
      readonly names: readonly string[];
      readonly ids: readonly string[];
    };

/** "Is anything broken?": waits for every row, counts a failed read as needing the builder, skips rows that are off. */
export function summarise(rows: readonly OverviewRow[]): Summary {
  if (rows.some((row) => row.state.kind === 'loading')) return { kind: 'loading' };
  const needs = rows.filter(needsBuilder);
  if (needs.length > 0)
    return { kind: 'needs', names: needs.map((r) => r.name), ids: needs.map((r) => r.id) };
  const counted = rows.filter(
    (row) => row.state.kind === 'ready' && row.state.tone !== ConnectionTone.Off,
  );
  return { kind: 'ok', count: counted.length };
}
