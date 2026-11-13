import type { AccountDto } from '@10db/contracts';
import { Anchor, Divider, Paper, Skeleton, Stack, Text, Title } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import type { UseQueryResult } from '@tanstack/react-query';
import { Fragment } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import { useBenchmarkStatus } from '../../daemon/benchmark-queries';
import { useGithubStatus } from '../../daemon/github-queries';
import { useJudgeStatus } from '../../daemon/judge-queries';
import { useCatalogueStatus } from '../../daemon/model-queries';
import { useSlackConnection } from '../../daemon/people';
import { useProjects, useSystemCheck } from '../../daemon/queries';
import { useSelfUpdate } from '../../daemon/self-update-queries';
import { useNow } from '../../shell/relative';
import { accountUsedBy } from './accounts/used-by';
import { OverviewRowView } from './overview-row';
import {
  accountState,
  agentState,
  benchmarkState,
  catalogueState,
  githubState,
  OverviewGroup,
  selfUpdateState,
  slackState,
  sortRows,
  summarise,
  type OverviewRow,
  type RowMark,
  type RowState,
  type Summary,
} from './overview-rows';
import { MARK_OF_KIND } from './row-mark';
import { SettingsSectionKey } from './sections';

interface Shell {
  readonly id: string;
  readonly name: string;
  readonly group: OverviewGroup;
  readonly mark: RowMark;
  readonly link: OverviewRow['link'];
}

/** A row whose query has no answer: still loading, or a failed read the builder can retry. */
function unread(query: UseQueryResult, shell: Shell): OverviewRow {
  if (query.isError)
    return {
      ...shell,
      state: { kind: 'failed' },
      retry: () => {
        void query.refetch();
      },
    };
  return { ...shell, state: { kind: 'loading' }, retry: null };
}

/** A row from one query: what `read` makes of its answer, else `unread`. */
function fromQuery<T>(
  query: UseQueryResult<T>,
  shell: Shell,
  read: (data: T) => RowState,
): OverviewRow {
  if (query.data === undefined) return unread(query, shell);
  return { ...shell, state: read(query.data), retry: null };
}

function accountRows(
  query: UseQueryResult<AccountDto[]>,
  usedBy: (account: AccountDto) => readonly string[],
): OverviewRow[] {
  const link = { section: SettingsSectionKey.Accounts, focus: null };
  const shell = { group: OverviewGroup.Access, mark: 'key' as const, link };
  if (query.data === undefined)
    return [unread(query, { ...shell, id: 'accounts', name: 'Accounts' })];
  return query.data
    .filter((account) => !account.archived)
    .map((account) => ({
      ...shell,
      id: account.id,
      name: account.label,
      mark: MARK_OF_KIND[account.kind],
      link: { section: SettingsSectionKey.Accounts, focus: account.id },
      state: accountState(account, usedBy(account)),
      retry: null,
    }));
}

/** Every connection's row, built from the queries the cards and sections already use. */
function useOverviewRows(): OverviewRow[] {
  const now = useNow();
  const accounts = useAccounts();
  const projects = useProjects();
  const judge = useJudgeStatus();
  const github = useGithubStatus();
  const slack = useSlackConnection();
  const benchmarks = useBenchmarkStatus();
  const catalogue = useCatalogueStatus();
  const system = useSystemCheck();
  const selfUpdate = useSelfUpdate();
  const integrations = (focus: string) => ({ section: SettingsSectionKey.Integrations, focus });
  const updates = { section: SettingsSectionKey.Updates, focus: null };
  const agentRows: OverviewRow[] =
    system.data === undefined
      ? [
          unread(system, {
            id: 'agent-copies',
            name: 'Claude Code and Codex',
            group: OverviewGroup.Data,
            mark: 'terminal',
            link: updates,
          }),
        ]
      : (system.data.agents ?? []).map((agent) => ({
          id: `agent-${agent.tool}`,
          name: agent.label,
          group: OverviewGroup.Data,
          mark: 'terminal',
          link: updates,
          state: agentState(agent),
          retry: null,
        }));
  return sortRows([
    ...accountRows(accounts, (account) => accountUsedBy(account, projects.data ?? [], judge.data)),
    fromQuery(
      github,
      {
        id: 'github',
        name: 'GitHub',
        group: OverviewGroup.Services,
        mark: 'github',
        link: integrations('github'),
      },
      githubState,
    ),
    fromQuery(
      slack,
      {
        id: 'slack',
        name: 'Slack',
        group: OverviewGroup.Services,
        mark: 'slack',
        link: integrations('slack'),
      },
      slackState,
    ),
    fromQuery(
      benchmarks,
      {
        id: 'artificial-analysis',
        name: 'Artificial Analysis',
        group: OverviewGroup.Services,
        mark: 'gauge',
        link: integrations('artificial-analysis'),
      },
      (status) => benchmarkState(status, now),
    ),
    fromQuery(
      catalogue,
      {
        id: 'models-dev',
        name: 'models.dev',
        group: OverviewGroup.Data,
        mark: 'database',
        link: { section: SettingsSectionKey.Models, focus: null },
      },
      (status) => catalogueState(status, now),
    ),
    ...agentRows,
    fromQuery(
      selfUpdate,
      {
        id: 'self-update',
        name: 'Self-update',
        group: OverviewGroup.Data,
        mark: 'refresh',
        link: updates,
      },
      selfUpdateState,
    ),
  ]);
}

const GROUP_TITLE: Readonly<Record<OverviewGroup, string>> = {
  [OverviewGroup.Access]: 'Model access',
  [OverviewGroup.Services]: 'Services',
  [OverviewGroup.Data]: 'Data and downloads',
};

const GROUPS: readonly OverviewGroup[] = [
  OverviewGroup.Access,
  OverviewGroup.Services,
  OverviewGroup.Data,
];

function SummaryLine({ summary }: { readonly summary: Summary }) {
  switch (summary.kind) {
    case 'loading':
      return <Skeleton height={20} width={260} />;
    case 'ok':
      return (
        <Text>
          {summary.count === 1
            ? 'The 1 connection works.'
            : `All ${String(summary.count)} connections work.`}
        </Text>
      );
    case 'needs':
      return (
        <Text>
          {summary.names.length === 1
            ? '1 needs you: '
            : `${String(summary.names.length)} need you: `}
          {summary.names.map((name, i) => (
            <Fragment key={summary.ids[i]}>
              {i > 0 ? ', ' : null}
              <Anchor
                // Inside a line of text, so it is underlined rather than told apart by color alone.
                underline="always"
                renderRoot={(props) => (
                  <Link
                    {...props}
                    to="/settings/$section"
                    params={{ section: SettingsSectionKey.Overview }}
                    search={{ focus: summary.ids[i] ?? '' }}
                  />
                )}
              >
                {name}
              </Anchor>
            </Fragment>
          ))}
          .
        </Text>
      );
  }
}

/** Settings › Overview: every connection's state at once, each row a link to what fixes it. */
export function OverviewSection() {
  const rows = useOverviewRows();
  const summary = summarise(rows);
  return (
    <Stack gap="lg">
      <SummaryLine summary={summary} />
      {GROUPS.map((group) => {
        const inGroup = rows.filter((row) => row.group === group);
        if (inGroup.length === 0) return null;
        return (
          <Stack key={group} gap="xs">
            <Title order={5}>{GROUP_TITLE[group]}</Title>
            <Paper withBorder radius="md" style={{ overflow: 'hidden' }}>
              {inGroup.map((row, i) => (
                <Fragment key={row.id}>
                  {i > 0 ? <Divider /> : null}
                  <OverviewRowView row={row} />
                </Fragment>
              ))}
            </Paper>
          </Stack>
        );
      })}
    </Stack>
  );
}
