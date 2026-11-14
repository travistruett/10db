import { AgentCopyState, CatalogueAttempt, CatalogueSource, ToolName } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { accountDto } from '../../test/account-fixtures';
import { benchmarkStatusDto } from '../../test/benchmark-fixtures';
import { githubStatusDto } from '../../test/github-fixtures';
import { slackConnection } from '../../test/people-fixtures';
import { ConnectionTone } from './connection-status';
import { SettingsSectionKey } from './sections';
import {
  accountState,
  agentState,
  benchmarkState,
  catalogueState,
  githubState,
  OverviewGroup,
  slackState,
  selfUpdateState,
  sortRows,
  summarise,
  type OverviewRow,
  type RowState,
} from './overview-rows';

const AA_WITHOUT =
  "Models are compared without scores: each role takes its tier's model at its default effort.";
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const AGO_2_MIN = '2026-11-12T11:58:00.000Z';
const AGO_2_H = '2026-11-12T10:00:00.000Z';

const ready = (tone: ConnectionTone, label: string, detail: string | null = null): RowState => ({
  kind: 'ready',
  tone,
  label,
  detail,
});

describe('an account row', () => {
  it.each([
    {
      name: 'a ready account used by nothing',
      account: accountDto({ expectedIdentity: 'a@example.com' }),
      used: [],
      want: ready(ConnectionTone.Works, 'Ready', 'Used by nothing'),
    },
    {
      name: 'a ready account used by a project and decisions',
      account: accountDto({ expectedIdentity: 'a@example.com' }),
      used: ["Renewals' agents", 'decisions'],
      want: ready(ConnectionTone.Works, 'Ready', "Used by: Renewals' agents, decisions"),
    },
    {
      name: 'a plan never signed in',
      account: accountDto({ expectedIdentity: null }),
      used: [],
      want: ready(ConnectionTone.NeedsYou, 'Needs sign-in', 'Used by nothing'),
    },
    {
      name: 'an API key with no secret',
      account: accountDto({ kind: 'anthropic_api_key', settings: {}, secretSet: false }),
      used: [],
      want: ready(ConnectionTone.NeedsYou, 'Needs a secret', 'Used by nothing'),
    },
    {
      name: 'an OpenRouter key with no secret that decisions run on',
      account: accountDto({ kind: 'openrouter', settings: {}, secretSet: false }),
      used: ['decisions'],
      want: ready(ConnectionTone.NeedsYou, 'Needs a secret', 'Used by: decisions'),
    },
  ])('$name', ({ account, used, want }) => {
    expect(accountState(account, used)).toEqual(want);
  });
});

describe('a service row', () => {
  it.each([
    {
      name: 'github signed in',
      got: githubState(githubStatusDto({ login: 'octocat' })),
      want: ready(ConnectionTone.Works, 'Signed in as octocat'),
    },
    {
      name: 'github signed out',
      got: githubState(githubStatusDto({ state: 'signed_out', login: null })),
      want: ready(
        ConnectionTone.NeedsYou,
        'Not signed in',
        'Pull requests, CI checks and self-update stop; projects can still commit directly.',
      ),
    },
    {
      name: 'github not installed',
      got: githubState(githubStatusDto({ state: 'not_installed', login: null })),
      want: ready(
        ConnectionTone.NeedsYou,
        "gh isn't installed",
        'Pull requests, CI checks and self-update stop; projects can still commit directly.',
      ),
    },
    {
      name: 'github unreachable',
      got: githubState(githubStatusDto({ state: 'unreachable', login: null })),
      want: ready(
        ConnectionTone.NeedsYou,
        "Couldn't reach GitHub",
        'Pull requests, CI checks and self-update stop; projects can still commit directly.',
      ),
    },
    {
      name: 'slack connected',
      got: slackState(slackConnection({ state: 'connected', teamName: 'Ampsio' })),
      want: ready(ConnectionTone.Works, 'Ampsio · posts as @10db'),
    },
    {
      name: 'slack refused',
      got: slackState(slackConnection({ state: 'refused' })),
      want: ready(
        ConnectionTone.NeedsYou,
        'Token refused',
        'Questions for other people stay in your Inbox; nothing is sent.',
      ),
    },
    {
      name: 'slack off by switch',
      got: slackState(slackConnection({ state: 'off' })),
      want: ready(ConnectionTone.Off, 'Off: 10db was started with TENDB_SLACK=off'),
    },
    {
      name: 'slack not connected',
      got: slackState(slackConnection({ state: 'none' })),
      want: ready(
        ConnectionTone.NeedsYou,
        'Not connected',
        'Questions for other people stay in your Inbox; nothing is sent.',
      ),
    },
    {
      name: 'aa with no key',
      got: benchmarkState(benchmarkStatusDto(), NOW),
      want: ready(ConnectionTone.NeedsYou, 'No key', AA_WITHOUT),
    },
    {
      name: 'aa refused',
      got: benchmarkState(
        benchmarkStatusDto({ keyConfigured: true, outcome: 'unauthorized' }),
        NOW,
      ),
      want: ready(ConnectionTone.NeedsYou, 'AA refused this key', AA_WITHOUT),
    },
    {
      name: 'aa synced',
      got: benchmarkState(
        benchmarkStatusDto({
          keyConfigured: true,
          outcome: 'ok',
          lastSuccessAt: AGO_2_H,
          models: 120,
        }),
        NOW,
      ),
      want: ready(ConnectionTone.Works, 'Key set · synced 2h ago · 120 models'),
    },
    {
      name: 'aa key set, sync failed',
      got: benchmarkState(
        benchmarkStatusDto({
          keyConfigured: true,
          outcome: 'failed',
          message: 'timeout',
          lastSuccessAt: AGO_2_H,
          models: 120,
        }),
        NOW,
      ),
      want: ready(
        ConnectionTone.Works,
        'Key set · synced 2h ago · 120 models',
        'Sync failed: timeout. Routing uses the last good scores.',
      ),
    },
    {
      name: 'aa off by switch',
      got: benchmarkState(benchmarkStatusDto({ off: true }), NOW),
      want: ready(ConnectionTone.Off, 'Off: 10db was started with TENDB_BENCHMARKS=off'),
    },
  ])('$name', ({ got, want }) => {
    expect(got).toEqual(want);
  });
});

describe('a data and downloads row', () => {
  const catalogue = { fetchedAt: AGO_2_MIN, source: CatalogueSource.Fetched, models: 660 };
  const agent = {
    tool: ToolName.Claude,
    label: 'Claude Code',
    pinned: '2.1.302',
    state: AgentCopyState.Ready,
    problem: null,
    newerRelease: null,
  };
  it.each([
    {
      name: 'models.dev fetched',
      got: catalogueState({ ...catalogue, lastAttempt: CatalogueAttempt.Succeeded }, NOW),
      want: ready(ConnectionTone.Works, '660 models · fetched 2 minutes ago'),
    },
    {
      name: 'models.dev unreachable',
      got: catalogueState({ ...catalogue, lastAttempt: CatalogueAttempt.Failed }, NOW),
      want: ready(
        ConnectionTone.NeedsYou,
        "Couldn't reach models.dev",
        'Showing the copy from 2 minutes ago, 660 models.',
      ),
    },
    {
      name: 'models.dev never loaded',
      got: catalogueState(
        {
          fetchedAt: null,
          source: CatalogueSource.None,
          models: 0,
          lastAttempt: CatalogueAttempt.NotTried,
        },
        NOW,
      ),
      want: ready(ConnectionTone.NeedsYou, 'No catalogue yet'),
    },
    {
      name: 'models.dev switched off',
      got: catalogueState({ ...catalogue, lastAttempt: CatalogueAttempt.Off }, NOW),
      want: ready(ConnectionTone.Off, 'Off: 10db was started with TENDB_CATALOGUE=off'),
    },
    {
      name: 'a ready agent copy',
      got: agentState(agent),
      want: ready(ConnectionTone.Works, '2.1.302 · ready'),
    },
    {
      name: 'an agent copy downloading',
      got: agentState({ ...agent, state: AgentCopyState.Fetching }),
      want: ready(ConnectionTone.Off, '2.1.302 · downloading'),
    },
    {
      name: 'a refused agent copy',
      got: agentState({ ...agent, state: AgentCopyState.Refused, problem: 'changed files' }),
      want: ready(ConnectionTone.NeedsYou, '2.1.302 · refused', 'changed files'),
    },
  ])('$name', ({ got, want }) => {
    expect(got).toEqual(want);
  });
});

describe('the self-update row', () => {
  const base = {
    enabled: true,
    runningCommit: 'a'.repeat(40),
    availableCommit: null,
    blocker: null,
  };
  it.each([
    {
      name: 'running from source',
      status: {
        ...base,
        runningCommit: null,
        blocker: { kind: 'source' as const, message: 'x' },
      },
      want: ready(ConnectionTone.Off, 'Runs from source, never updates itself'),
    },
    {
      name: 'turned off',
      status: { ...base, enabled: false },
      want: ready(ConnectionTone.Off, 'Off: you turned it off in Updates'),
    },
    {
      name: 'up to date',
      status: base,
      want: ready(ConnectionTone.Works, 'Running aaaaaaa'),
    },
    {
      name: 'an update on the way',
      status: { ...base, availableCommit: 'b'.repeat(40) },
      want: ready(ConnectionTone.Works, 'Running aaaaaaa · bbbbbbb is next'),
    },
    {
      name: 'github unreachable',
      status: { ...base, blocker: { kind: 'unreachable' as const, message: 'Offline.' } },
      want: ready(ConnectionTone.NeedsYou, "Can't see new builds", 'Offline.'),
    },
  ])('$name', ({ status, want }) => {
    expect(selfUpdateState(status)).toEqual(want);
  });
});

const row = (
  id: string,
  state: RowState,
  group: OverviewGroup = OverviewGroup.Services,
): OverviewRow => ({
  id,
  name: id,
  group,
  mark: 'key',
  link: { section: SettingsSectionKey.Accounts, focus: null },
  state,
  retry: null,
});

describe('sorting and the summary line', () => {
  const works = ready(ConnectionTone.Works, 'ok');
  const needs = ready(ConnectionTone.NeedsYou, 'no');
  const off = ready(ConnectionTone.Off, 'off');

  it('puts rows that need the builder first within each group, keeping the order otherwise', () => {
    const sorted = sortRows([
      row('a', works),
      row('b', needs),
      row('c', works),
      row('d', { kind: 'failed' }),
      row('e', needs, OverviewGroup.Data),
      row('f', works, OverviewGroup.Data),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['b', 'd', 'a', 'c', 'e', 'f']);
  });

  it.each([
    {
      name: 'everything works, off rows not counted',
      rows: [row('a', works), row('b', works), row('c', off)],
      want: { kind: 'ok', count: 2 },
    },
    {
      name: 'rows that need the builder, a failed read among them',
      rows: [row('a', works), row('b', needs), row('c', { kind: 'failed' }), row('d', off)],
      want: { kind: 'needs', names: ['b', 'c'], ids: ['b', 'c'] },
    },
    {
      name: 'a row still loading',
      rows: [row('a', works), row('b', { kind: 'loading' })],
      want: { kind: 'loading' },
    },
    {
      name: 'every connection off',
      rows: [row('a', off)],
      want: { kind: 'ok', count: 0 },
    },
  ])('$name', ({ rows, want }) => {
    expect(summarise(rows)).toEqual(want);
  });
});
