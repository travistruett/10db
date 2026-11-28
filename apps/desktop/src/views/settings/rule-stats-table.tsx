import {
  DECISION_RULE_NAMES,
  isWorthALook,
  RULE_MARKS_KEPT,
  sampleFirst,
  type ProjectId,
  type RuleStatsDto,
} from '@10db/contracts';
import { Alert, Badge, Group, Stack, Text, Tooltip } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { useProjects } from '../../daemon/queries';
import { useRuleStats } from '../../daemon/rule-stats-queries';
import { ProjectFilter } from '../../shell/project-filter';
import { RaisedPanel } from '../../shell/raised-panel';

const WORTH_A_LOOK_HINT = 'Deciding more each week, never undone';
const EMPTY = '10db has decided nothing by rule in the last 30 days.';

/** A mark's count tops out at what the record keeps, so a count at the cap is "at least" that many. */
function markCount(count: number): string {
  return count >= RULE_MARKS_KEPT ? `${String(RULE_MARKS_KEPT)}+` : String(count);
}

/** Whether a rule did, or was asked to do, anything worth a row: with none, the tab says so instead. */
function isQuiet(row: RuleStatsDto): boolean {
  return row.decided === 0 && row.undone === 0 && row.sentUp === 0 && !row.asking;
}

const COLUMNS: DataTableColumn<RuleStatsDto>[] = [
  {
    accessor: 'rule',
    title: 'Rule',
    render: (row) => (
      <Group gap="xs" wrap="nowrap">
        <Text size="sm" fw={500}>
          {DECISION_RULE_NAMES[row.rule]}
        </Text>
        {row.asking ? (
          <Badge color="yellow" variant="light" style={{ flex: 'none' }}>
            Asks you
          </Badge>
        ) : null}
        {isWorthALook(row) ? (
          <Tooltip label={WORTH_A_LOOK_HINT}>
            <Badge color="violet" variant="light" style={{ flex: 'none' }}>
              Worth a Look
            </Badge>
          </Tooltip>
        ) : null}
      </Group>
    ),
  },
  { accessor: 'decided', title: 'Decided', textAlign: 'right', noWrap: true },
  { accessor: 'undone', title: 'Undone', textAlign: 'right', noWrap: true },
  {
    accessor: 'sentUp',
    title: 'Sent Up',
    textAlign: 'right',
    noWrap: true,
    render: (row) => markCount(row.sentUp),
  },
  { accessor: 'lastWeek', title: 'This Week', textAlign: 'right', noWrap: true },
  { accessor: 'weekBefore', title: 'Last Week', textAlign: 'right', noWrap: true },
];

/**
 * Each rule's decisions, undos and escalations over the last 30 days, in one project or all of them. The rules
 * that decide more this week than last with nobody undoing them come first, so the ones nobody is checking
 * are the first to read.
 */
export function RuleStatsTable() {
  const [project, setProject] = useState<ProjectId | null>(null);
  const stats = useRuleStats(project);
  const projects = useProjects();
  const rows = stats.data === undefined ? [] : sampleFirst(stats.data.rules);
  const records = rows.every(isQuiet) ? [] : rows;
  return (
    <Stack gap="sm">
      <Group justify="flex-end">
        <ProjectFilter projects={projects.data ?? []} value={project} onChange={setProject} />
      </Group>
      {stats.isError ? <Alert color="red">{stats.error.message}</Alert> : null}
      <RaisedPanel>
        <DataTable<RuleStatsDto>
          aria-label="Rules"
          records={records}
          columns={COLUMNS}
          idAccessor="rule"
          fetching={stats.isPending}
          noRecordsText={EMPTY}
          backgroundColor="transparent"
          verticalSpacing="xs"
          horizontalSpacing="sm"
          {...(records.length === 0 ? { minHeight: 160 } : {})}
        />
      </RaisedPanel>
    </Stack>
  );
}
