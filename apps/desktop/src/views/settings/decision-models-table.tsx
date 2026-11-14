import type { DecisionModelDto, JudgeDecision } from '@10db/contracts';
import { Text, UnstyledButton } from '@mantine/core';
import { DataTable, type DataTableColumn, type DataTableSortStatus } from 'mantine-datatable';
import { useState } from 'react';
import { withColumnHeader } from '../../shell/column-header';
import { pagerProps, TABLE_PAGE_SIZES, usePaging } from '../../shell/table-pager';
import { DECISIONS } from './decision-catalogue';
import { formatDecisionUsd } from './decision-numbers';
import { NO_DATA } from './model-format';
import { decisionSourceText } from './number-source';
import { SourcedNumber } from './sourced-number';

const SortColumn = { Name: 'name', Cost: 'cost', Time: 'time', Answers: 'answers' } as const;
type SortColumn = (typeof SortColumn)[keyof typeof SortColumn];

const isSortColumn = (value: unknown): value is SortColumn =>
  Object.values(SortColumn).some((c) => c === value);

export const costText = (model: DecisionModelDto): string =>
  model.costPerMillionUsd === null
    ? NO_DATA
    : model.costPerMillionUsd === 0
      ? 'Free'
      : formatDecisionUsd(model.costPerMillionUsd);

export const timeText = (model: DecisionModelDto): string =>
  model.secondsPerDecision === null
    ? NO_DATA
    : `${String(Number(model.secondsPerDecision.toPrecision(3)))} s`;

const TABULAR = () => ({ fontVariantNumeric: 'tabular-nums' });

/** Every decision model with what a decision on it costs and takes, who uses it and how often it answered. */
export function DecisionModelsTable({
  models,
  usedBy,
  answers,
  onOpen,
}: {
  readonly models: readonly DecisionModelDto[];
  /** The decisions whose model each id is. */
  readonly usedBy: ReadonlyMap<string, readonly JudgeDecision[]>;
  readonly answers: ReadonlyMap<string, number>;
  readonly onOpen: (model: DecisionModelDto) => void;
}) {
  const [sort, setSort] = useState<DataTableSortStatus<DecisionModelDto>>({
    columnAccessor: SortColumn.Name,
    direction: 'asc',
  });
  const paging = usePaging(JSON.stringify(sort), TABLE_PAGE_SIZES[0]);
  const key = (m: DecisionModelDto): number | string | null => {
    switch (isSortColumn(sort.columnAccessor) ? sort.columnAccessor : SortColumn.Name) {
      case SortColumn.Cost:
        return m.costPerMillionUsd;
      case SortColumn.Time:
        return m.secondsPerDecision;
      case SortColumn.Answers:
        return answers.get(m.id) ?? 0;
      case SortColumn.Name:
        return m.name.toLowerCase();
    }
  };
  const sign = sort.direction === 'asc' ? 1 : -1;
  const sorted = [...models].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    // A model with no number sits last whichever way the list runs.
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    if (typeof x === 'string' || typeof y === 'string')
      return sign * String(x).localeCompare(String(y));
    return sign * (x - y);
  });
  const page = Math.min(paging.page, Math.max(1, Math.ceil(sorted.length / paging.pageSize)));
  const shown = sorted.slice((page - 1) * paging.pageSize, page * paging.pageSize);
  const onSort = (next: DataTableSortStatus<DecisionModelDto>): void => {
    if (isSortColumn(next.columnAccessor)) setSort(next);
  };
  const head = (column: DataTableColumn<DecisionModelDto>) =>
    withColumnHeader(column, sort, onSort);
  const numeric = (
    accessor: SortColumn,
    title: string,
    render: (m: DecisionModelDto) => React.ReactNode,
  ) =>
    head({
      accessor,
      title,
      textAlign: 'right',
      noWrap: true,
      sortable: true,
      cellsStyle: TABULAR,
      render,
    });
  const columns: DataTableColumn<DecisionModelDto>[] = [
    head({
      accessor: SortColumn.Name,
      title: 'Model',
      sortable: true,
      width: '100%',
      render: (m) => (
        <div style={m.cantCall === null ? undefined : { opacity: 0.6 }}>
          <UnstyledButton
            aria-label={`Open ${m.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen(m);
            }}
          >
            <Text size="sm" fw={500} span>
              {m.name}
            </Text>
            <Text size="xs" c="dimmed" span>
              {' '}
              {m.maker}
            </Text>
          </UnstyledButton>
          {m.cantCall === null ? null : (
            <Text size="xs" c="dimmed">
              {m.cantCall}
            </Text>
          )}
        </div>
      ),
    }),
    numeric(SortColumn.Cost, 'Cost per million decisions', (m) => (
      <SourcedNumber
        text={costText(m)}
        source={m.costSource === null ? null : decisionSourceText(m.costSource)}
      />
    )),
    numeric(SortColumn.Time, 'Time per decision', (m) => (
      <SourcedNumber
        text={timeText(m)}
        source={m.timeSource === null ? null : decisionSourceText(m.timeSource)}
      />
    )),
    {
      accessor: 'usedBy',
      title: 'Used by',
      render: (m) => {
        const names = (usedBy.get(m.id) ?? []).map((d) => DECISIONS[d].label).join(', ');
        return (
          <Text size="xs" truncate maw={240} title={names}>
            {names}
          </Text>
        );
      },
    },
    numeric(SortColumn.Answers, 'Answers (30 days)', (m) => String(answers.get(m.id) ?? 0)),
  ];
  return (
    <DataTable<DecisionModelDto>
      aria-label="All decision models"
      records={shown}
      columns={columns}
      idAccessor="id"
      withTableBorder
      backgroundColor="var(--tendb-color-panel)"
      borderRadius="md"
      verticalSpacing="sm"
      horizontalSpacing="md"
      highlightOnHover
      {...pagerProps({ ...paging, page, total: sorted.length }, TABLE_PAGE_SIZES)}
      onRowClick={({ record }) => {
        onOpen(record);
      }}
    />
  );
}
