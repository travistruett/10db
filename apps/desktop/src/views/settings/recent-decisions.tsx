import {
  JudgeDecision,
  JudgeOutcome,
  type DecisionModelDto,
  type JudgeCallDto,
} from '@10db/contracts';
import { ActionIcon, Select, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { DataTable, type DataTableColumn, type DataTableSortStatus } from 'mantine-datatable';
import { useState, type ReactNode } from 'react';
import { useJudgeCallsPage } from '../../daemon/judge-queries';
import { withColumnHeader } from '../../shell/column-header';
import { absoluteTime, fromNow, useNow } from '../../shell/relative';
import { pagerProps, TABLE_PAGE_SIZES, usePaging } from '../../shell/table-pager';
import { DECISIONS } from './decision-catalogue';
import { answerText, modelName, outcomeText } from './decision-numbers';
import { RaisedPanel } from '../../shell/raised-panel';

const ANY_DECISION = 'any';
const ANY_OUTCOME = 'any';

const DECISION_CHOICES = [
  { value: ANY_DECISION, label: 'Any Decision' },
  ...Object.values(JudgeDecision).map((value) => ({ value, label: DECISIONS[value].label })),
];

const OUTCOME_CHOICES = [
  { value: ANY_OUTCOME, label: 'Any Outcome' },
  { value: JudgeOutcome.Acted, label: 'Acted' },
  { value: JudgeOutcome.BelowFloor, label: 'Not Sure Enough' },
  { value: JudgeOutcome.Overridden, label: 'Overridden' },
  { value: JudgeOutcome.Shadow, label: 'Shadow' },
  { value: JudgeOutcome.FallbackOff, label: 'Fell Back: Off' },
  { value: JudgeOutcome.FallbackNoKey, label: 'Fell Back: No Key' },
  { value: JudgeOutcome.FallbackTimeout, label: 'Fell Back: Timed Out' },
  { value: JudgeOutcome.FallbackError, label: 'Fell Back: Failed' },
  { value: JudgeOutcome.Stopped, label: 'Stopped' },
];

const isDecision = (value: string | null): value is JudgeDecision =>
  Object.values<string>(JudgeDecision).includes(value ?? '');
const isOutcome = (value: string | null): value is JudgeOutcome =>
  Object.values<string>(JudgeOutcome).includes(value ?? '');

/** The table never sorts: calls are newest first, as the daemon pages them. */
const NEWEST_FIRST: DataTableSortStatus<JudgeCallDto> = {
  columnAccessor: 'createdAt',
  direction: 'desc',
};
const noSort = (): void => undefined;

/**
 * The judge's calls, newest first, in a table as tall as its page of rows (the page scrolls, not the table),
 * which the daemon pages and filters by decision and outcome. With a `decision`, the table is that decision's own and has no Decision column.
 */
export function RecentDecisions({
  decision,
  models,
}: {
  readonly decision?: JudgeDecision;
  readonly models?: readonly DecisionModelDto[];
}) {
  const [decisionFilter, setDecisionFilter] = useState<JudgeDecision | null>(null);
  const [outcome, setOutcome] = useState<JudgeOutcome | null>(null);
  const shownDecision = decision ?? decisionFilter;
  const paging = usePaging(`${shownDecision ?? ''}|${outcome ?? ''}`, 25);
  const page = useJudgeCallsPage({
    limit: paging.pageSize,
    offset: (paging.page - 1) * paging.pageSize,
    ...(shownDecision === null ? {} : { decision: shownDecision }),
    ...(outcome === null ? {} : { outcome }),
  });
  const now = useNow();
  const head = (column: DataTableColumn<JudgeCallDto>) =>
    withColumnHeader(column, NEWEST_FIRST, noSort);
  const columns: DataTableColumn<JudgeCallDto>[] = [
    {
      accessor: 'createdAt',
      title: 'When',
      noWrap: true,
      render: (call) => (
        <span title={absoluteTime(call.createdAt)}>{fromNow(call.createdAt, now)}</span>
      ),
    },
    head({
      accessor: 'decision',
      title: 'Decision',
      noWrap: true,
      hidden: decision !== undefined,
      filtering: decisionFilter !== null,
      filter: (
        <Select
          aria-label="Decision"
          size="xs"
          w={240}
          allowDeselect={false}
          checkIconPosition="right"
          // Inside the filter's popover: a dropdown in a portal would count as a click outside and close it.
          comboboxProps={{ withinPortal: false }}
          data={DECISION_CHOICES}
          value={decisionFilter ?? ANY_DECISION}
          onChange={(next) => {
            setDecisionFilter(isDecision(next) ? next : null);
          }}
        />
      ),
      render: (call) => DECISIONS[call.decision].label,
    }),
    {
      accessor: 'model',
      title: 'Model',
      noWrap: true,
      render: (call) => modelName(call.model, models),
    },
    {
      accessor: 'answer',
      title: 'Answer (Sure)',
      noWrap: true,
      render: (call) => answerText(call),
    },
    head({
      accessor: 'outcome',
      title: 'What 10db Did',
      noWrap: true,
      filtering: outcome !== null,
      filter: (
        <Select
          aria-label="What 10db Did"
          size="xs"
          w={240}
          allowDeselect={false}
          checkIconPosition="right"
          comboboxProps={{ withinPortal: false }}
          data={OUTCOME_CHOICES}
          value={outcome ?? ANY_OUTCOME}
          onChange={(next) => {
            setOutcome(isOutcome(next) ? next : null);
          }}
        />
      ),
      render: (call) => outcomeText(call),
    }),
    {
      accessor: 'taskId',
      title: 'Task',
      textAlign: 'center',
      width: 64,
      render: (call) =>
        call.taskId === null ? null : (
          <Tooltip label="Open on the Board" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Open on the Board"
              renderRoot={(props) => <Link {...props} to="/board" search={{ task: call.taskId }} />}
            >
              <IconExternalLink size={14} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        ),
    },
  ];
  const calls = page.data?.calls ?? [];
  const filtered = decisionFilter !== null || outcome !== null;
  return (
    <Stack gap="xs">
      <Title order={decision === undefined ? 4 : 5}>Recent Decisions</Title>
      {/* On the page the table is a raised thing; in a decision's drawer it stays flat. */}
      <Raised when={decision === undefined}>
        <DataTable<JudgeCallDto>
          aria-label={
            decision === undefined
              ? 'Recent decisions'
              : `Recent decisions: ${DECISIONS[decision].label}`
          }
          records={calls}
          fetching={page.isPending}
          columns={columns}
          idAccessor="id"
          backgroundColor="transparent"
          verticalSpacing="sm"
          horizontalSpacing="md"
          highlightOnHover
          {...(calls.length === 0 ? { minHeight: 160 } : {})}
          emptyState={
            <Text c="dimmed" size="sm" ta="center">
              {page.isPending
                ? ''
                : page.isError
                  ? 'Recent decisions could not be read.'
                  : filtered
                    ? 'No decision matches these filters.'
                    : 'No decisions yet.'}
            </Text>
          }
          {...pagerProps(
            page.data === undefined ? undefined : { ...paging, total: page.data.total },
            TABLE_PAGE_SIZES,
          )}
        />
      </Raised>
    </Stack>
  );
}

function Raised({ when, children }: { readonly when: boolean; readonly children: ReactNode }) {
  return when ? <RaisedPanel>{children}</RaisedPanel> : children;
}
