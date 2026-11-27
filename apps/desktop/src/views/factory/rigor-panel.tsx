import {
  ALL_RIGORS,
  RIGOR_FIGURES_PERIODS,
  RIGORS,
  rigorTitle,
  type ProjectId,
  type RigorFiguresDto,
  type RigorFiguresPeriod,
  type RigorFiguresRowDto,
} from '@10db/contracts';
import { Alert, SegmentedControl, Stack, Table, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { useRigorFigures } from '../../daemon/rigor-figures-queries';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { RaisedPanel } from '../../shell/raised-panel';

/** The table's scroll width, kept by its placeholder. */
const TABLE_MIN_WIDTH = 900;

const COLUMNS = [
  'Rigor',
  'Tasks done',
  'Steps per task',
  'Sessions per task',
  'PRs per task',
  'Steps per goal',
  'Sessions per goal',
  'PRs per goal',
  'Sent back per task',
  'Shipped with findings',
] as const;

const rowLabel = (rigor: RigorFiguresRowDto['rigor']): string =>
  rigor === ALL_RIGORS ? 'All' : rigorTitle(rigor);

/** One decimal, none when whole; a dash when there was nothing to average. */
function figure(value: number | null): string {
  return value === null ? '–' : String(Number(value.toFixed(1)));
}

function share(value: number | null): string {
  return value === null ? '–' : `${String(Math.round(value * 100))}%`;
}

function periodOf(value: string): RigorFiguresPeriod | null {
  return RIGOR_FIGURES_PERIODS.find((p) => String(p) === value) ?? null;
}

function FigureRow({ row }: { readonly row: RigorFiguresRowDto }) {
  return (
    <Table.Tr>
      <Table.Td>{rowLabel(row.rigor)}</Table.Td>
      <Table.Td>{row.tasksDone}</Table.Td>
      <Table.Td>{figure(row.stepsPerTask)}</Table.Td>
      <Table.Td>{figure(row.sessionsPerTask)}</Table.Td>
      <Table.Td>{figure(row.pullRequestsPerTask)}</Table.Td>
      <Table.Td>{figure(row.stepsPerGoal)}</Table.Td>
      <Table.Td>{figure(row.sessionsPerGoal)}</Table.Td>
      <Table.Td>{figure(row.pullRequestsPerGoal)}</Table.Td>
      <Table.Td>{figure(row.sentBackPerTask)}</Table.Td>
      <Table.Td>{share(row.shippedWithFindings)}</Table.Td>
    </Table.Tr>
  );
}

function overrideLine(judgeOverride: RigorFiguresDto['judgeOverride']): string | null {
  return judgeOverride === null
    ? null
    : `You changed the judge's sizing ${String(judgeOverride.overridden)} of ${String(judgeOverride.calls)} times`;
}

/**
 * What each rigor's finished work took over a period: tasks done, and per task the steps that ran, the
 * sessions and the send-backs, with the pull requests per goal and the share that shipped with findings
 * filed. A task counts under the rigor it has now. Below, how often the builder overrode the judge's sizing.
 */
export function RigorPanel({ projectId }: { readonly projectId: ProjectId | null }) {
  const [days, setDays] = useState<RigorFiguresPeriod>(14);
  const figures = useRigorFigures(projectId, days);
  const override = figures.isSuccess ? overrideLine(figures.data.judgeOverride) : null;
  return (
    <Stack gap="xs">
      <Title order={3}>Rigor</Title>
      <Text size="sm" c="dimmed">
        Work per done task, by the rigor each task has now
      </Text>
      <SegmentedControl
        size="xs"
        w="fit-content"
        aria-label="Period"
        data={RIGOR_FIGURES_PERIODS.map((p) => ({ value: String(p), label: `${String(p)} days` }))}
        value={String(days)}
        onChange={(value) => {
          const next = periodOf(value);
          if (next !== null) setDays(next);
        }}
      />
      {figures.isError ? (
        <Alert color="red" title="Couldn't load the work per rigor">
          {figures.error.message}
        </Alert>
      ) : null}
      {figures.isLoading ? (
        <PageLoading
          shape={PageLoadingShape.Table}
          label="Loading work per rigor"
          columns={COLUMNS.map((title) => ({ title }))}
          // One row for each rigor, then the total.
          rows={RIGORS.length + 1}
          minWidth={TABLE_MIN_WIDTH}
        />
      ) : null}
      {figures.isSuccess ? (
        <>
          <RaisedPanel>
            <Table.ScrollContainer minWidth={TABLE_MIN_WIDTH}>
              <Table aria-label="Work per task by rigor">
                <Table.Thead>
                  <Table.Tr>
                    {COLUMNS.map((name) => (
                      <Table.Th key={name}>{name}</Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {figures.data.rows.map((row) => (
                    <FigureRow key={row.rigor} row={row} />
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </RaisedPanel>
          {override === null ? null : (
            <Text size="sm" c="dimmed">
              {override}
            </Text>
          )}
        </>
      ) : null}
    </Stack>
  );
}
