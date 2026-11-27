import { NewEvalOrigin, evalGapPath, type EvalGapDto, type EvalSuiteDto } from '@10db/contracts';
import { Button, Code, Group, Stack, Text } from '@mantine/core';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { pagerProps, TABLE_PAGE_SIZES, usePaging } from '../../shell/table-pager';
import { RaisedPanel } from '../../shell/raised-panel';
import classes from './evals-table.module.css';
import { dayText, latencyText, modelCostsText } from './eval-figures';
import { asBehavior, type NewEvalPrefill } from './new-eval-modal';
import { ModelLine, Trend } from './result-marks';

/** What a tile counts and filters by. */
export const EvalFilter = {
  Passing: 'passing',
  Failing: 'failing',
  NotRun: 'not-run',
  NoEval: 'no-eval',
} as const;
export type EvalFilter = (typeof EvalFilter)[keyof typeof EvalFilter];

/** One line of the table: a suite, LLM work with no eval, or an eval file no suite runs. */
export type EvalRow =
  | { readonly kind: 'suite'; readonly id: string; readonly suite: EvalSuiteDto }
  | { readonly kind: 'gap'; readonly id: string; readonly gap: EvalGapDto }
  | { readonly kind: 'file'; readonly id: string; readonly path: string };

/** Which tile a suite counts under. */
export function suiteFilter(suite: EvalSuiteDto): EvalFilter {
  if (suite.latest === null) return EvalFilter.NotRun;
  return suite.latest.passed ? EvalFilter.Passing : EvalFilter.Failing;
}

/** The page's rows, in order: failing suites, passing, not run, then the gaps and the unlinked files. */
export function evalRows(
  suites: readonly EvalSuiteDto[],
  gaps: readonly EvalGapDto[] | null,
  unlinked: readonly string[],
): EvalRow[] {
  const order = [EvalFilter.Failing, EvalFilter.Passing, EvalFilter.NotRun];
  return [
    ...order.flatMap((group) =>
      suites
        .filter((suite) => suiteFilter(suite) === group)
        .map((suite): EvalRow => ({ kind: 'suite', id: `suite:${suite.key}`, suite })),
    ),
    ...(gaps ?? []).map((gap): EvalRow => ({
      kind: 'gap',
      id: `gap:${gap.where}|${gap.label}`,
      gap,
    })),
    ...unlinked.map((path): EvalRow => ({ kind: 'file', id: `file:${path}`, path })),
  ];
}

/** Whether a row shows under a filter; every row shows with none. */
export function rowMatches(row: EvalRow, filter: EvalFilter | null): boolean {
  if (filter === null) return true;
  if (row.kind === 'suite') return suiteFilter(row.suite) === filter;
  return filter === EvalFilter.NoEval;
}

function Dim({ children }: { readonly children: string }) {
  return (
    <Text size="xs" c="dimmed">
      {children}
    </Text>
  );
}

/** The fixed column widths, shared with the loading skeleton so the two line up. */
export const EVAL_COLUMN_WIDTHS = { trend: 110, cost: 120, p50: 70, at: 150 } as const;

function columns(onNewEval: (prefill: NewEvalPrefill) => void): DataTableColumn<EvalRow>[] {
  return [
    {
      accessor: 'name',
      title: 'Name',
      width: 260,
      render: (row) => {
        switch (row.kind) {
          case 'suite': {
            // The bar in words, else where the suite is defined; never the name again.
            const under = row.suite.bar ?? row.suite.definitionPaths[0] ?? null;
            return (
              <Stack gap={2}>
                <Text size="sm" fw={500} c="var(--mantine-color-bright)">
                  {row.suite.label}
                </Text>
                {under === null ? null : (
                  <Text size="xs" c="dimmed" lineClamp={2} title={under}>
                    {under}
                  </Text>
                )}
              </Stack>
            );
          }
          case 'gap':
            return (
              <Stack gap={2}>
                <Text size="sm" fw={500} c="var(--mantine-color-bright)">
                  {row.gap.label}
                </Text>
                <Text size="xs" c="dimmed" lineClamp={2} title={row.gap.why}>
                  {row.gap.why}
                </Text>
              </Stack>
            );
          case 'file':
            return (
              <Stack gap={2}>
                <Text
                  size="sm"
                  fw={500}
                  c="var(--mantine-color-bright)"
                  style={{ wordBreak: 'break-all' }}
                >
                  {row.path}
                </Text>
                <Dim>An eval file no suite runs yet</Dim>
              </Stack>
            );
        }
      },
    },
    {
      accessor: 'result',
      title: 'Last Result per Model',
      render: (row) => {
        switch (row.kind) {
          case 'suite':
            return row.suite.latest === null ? (
              <Dim>{row.suite.format === null ? 'No results found' : 'No run could be read'}</Dim>
            ) : (
              <Stack gap={4}>
                {row.suite.latest.models.map((model) => (
                  <ModelLine key={`${model.slot ?? ''}${model.model}`} result={model} />
                ))}
              </Stack>
            );
          case 'gap':
            return (
              <Stack gap={2} align="flex-start">
                <Text size="sm">No eval yet</Text>
                <Code>{row.gap.where}</Code>
                <Dim>{row.gap.source === 'found' ? 'found at HEAD' : 'assessed'}</Dim>
              </Stack>
            );
          case 'file':
            return null;
        }
      },
    },
    {
      accessor: 'trend',
      title: 'Trend',
      width: EVAL_COLUMN_WIDTHS.trend,
      render: (row) => (row.kind === 'suite' ? <Trend runs={row.suite.trend} /> : null),
    },
    {
      accessor: 'cost',
      title: 'Cost a Run',
      textAlign: 'right',
      width: EVAL_COLUMN_WIDTHS.cost,
      render: (row) =>
        row.kind !== 'suite' ? null : (
          <Text
            size="sm"
            {...(row.suite.latest === null ? { c: 'dimmed' } : {})}
            style={{ whiteSpace: 'nowrap' }}
          >
            {row.suite.latest === null ? '—' : modelCostsText(row.suite.latest.models)}
          </Text>
        ),
    },
    {
      accessor: 'p50',
      title: 'p50',
      textAlign: 'right',
      width: EVAL_COLUMN_WIDTHS.p50,
      render: (row) =>
        row.kind !== 'suite' ? null : (
          <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {latencyText(row.suite.latest?.models[0]?.latencyP50Ms ?? null)}
          </Text>
        ),
    },
    {
      accessor: 'at',
      title: 'Last Run',
      textAlign: 'right',
      width: EVAL_COLUMN_WIDTHS.at,
      render: (row) => {
        switch (row.kind) {
          case 'suite':
            return (
              <Stack gap={2} align="flex-end">
                <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  {row.suite.latest === null ? '—' : dayText(row.suite.latest.at)}
                </Text>
                {row.suite.definitionChangedAt === null ? null : (
                  <Text size="xs" c="dimmed" ta="right">
                    {`eval changed ${dayText(row.suite.definitionChangedAt)}`}
                  </Text>
                )}
              </Stack>
            );
          case 'gap':
            return (
              <Group justify="flex-end">
                <Button
                  size="compact-xs"
                  variant="default"
                  aria-label={`New Eval for ${row.gap.label}`}
                  onClick={() => {
                    onNewEval({
                      behavior: asBehavior(row.gap.label),
                      evidence: row.gap.why,
                      where: [evalGapPath(row.gap.where)],
                      origin: NewEvalOrigin.Gap,
                    });
                  }}
                >
                  New Eval
                </Button>
              </Group>
            );
          case 'file':
            return null;
        }
      },
    },
  ];
}

/**
 * The project's evals as one raised table, 25 a page: suites, then LLM work with no eval and eval files no suite
 * runs. A suite row opens its drawer; the others have their own button.
 */
export function EvalsTable({
  rows,
  filter,
  openKey,
  notAssessed,
  onOpen,
  onNewEval,
}: {
  /** The rows the filter keeps. */
  readonly rows: readonly EvalRow[];
  readonly filter: EvalFilter | null;
  readonly openKey: string | null;
  /** No assessment has said what has no eval, so an empty No Eval is not an answer. */
  readonly notAssessed: boolean;
  readonly onOpen: (suite: EvalSuiteDto) => void;
  readonly onNewEval: (prefill: NewEvalPrefill) => void;
}) {
  const paging = usePaging(filter ?? 'all', TABLE_PAGE_SIZES[0]);
  // A list that shrank under the reader never leaves them on a page past its end.
  const page = Math.min(paging.page, Math.max(1, Math.ceil(rows.length / paging.pageSize)));
  const from = (page - 1) * paging.pageSize;
  return (
    <RaisedPanel>
      <DataTable<EvalRow>
        aria-label="Evals"
        records={rows.slice(from, from + paging.pageSize)}
        columns={columns(onNewEval)}
        idAccessor="id"
        backgroundColor="transparent"
        verticalSpacing="sm"
        horizontalSpacing="md"
        {...(rows.length > TABLE_PAGE_SIZES[0]
          ? pagerProps({ ...paging, page, total: rows.length }, TABLE_PAGE_SIZES)
          : {})}
        {...(rows.length === 0 ? { minHeight: 120 } : {})}
        emptyState={
          <Text c="dimmed" size="sm" ta="center">
            {filter === EvalFilter.NoEval && !notAssessed
              ? 'Every LLM task has an eval.'
              : 'Nothing matches this filter.'}
          </Text>
        }
        onRowClick={({ record }) => {
          if (record.kind === 'suite') onOpen(record.suite);
        }}
        customRowAttributes={(row) => (row.kind === 'suite' ? { 'data-keeps-drawer': '' } : {})}
        rowClassName={(row) => (row.kind === 'suite' ? classes['suite'] : undefined)}
        rowStyle={(row) =>
          row.kind === 'suite' && row.suite.key === openKey
            ? { background: 'var(--mantine-color-default-hover)' }
            : { cursor: row.kind === 'suite' ? 'pointer' : 'default' }
        }
      />
    </RaisedPanel>
  );
}
