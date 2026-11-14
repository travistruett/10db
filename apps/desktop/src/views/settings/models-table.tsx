import { ModelStatus, type ModelRowDto } from '@10db/contracts';
import { Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { DataTable, type DataTableColumn, type DataTableSortStatus } from 'mantine-datatable';
import { useState, type ReactNode } from 'react';
import { pagerProps, TABLE_PAGE_SIZES, type TablePage } from '../../shell/table-pager';
import { withColumnHeader } from '../../shell/column-header';
import { SourcedNumber } from './sourced-number';
import { modelSourceText } from './number-source';
import { ModelSearchFilter, TierFilter } from './model-filters';
import { formatCost, formatScore, NO_DATA } from './model-format';
import type { ModelFamily } from './model-families';
import { STATUS_LABEL, TIER_LABEL } from './model-labels';
import {
  isNewModel,
  ModelColumn,
  SortDirection,
  type ModelFilter,
  type ModelSort,
} from './model-order';

const isModelColumn = (value: unknown): value is ModelColumn =>
  Object.values(ModelColumn).some((c) => c === value);

const TABULAR = () => ({ fontVariantNumeric: 'tabular-nums' });

/** The name on one line, then its status as dimmed text, and New in blue. The button is the keyboard's way to a row's click. */
function ModelCell({
  row,
  fresh,
  older,
  expanded,
  nested,
  onOpen,
  onToggle,
}: {
  readonly row: ModelRowDto;
  readonly fresh: boolean;
  /** How many older versions sit under this row; zero shows no toggle. */
  readonly older: number;
  readonly expanded: boolean;
  /** An older version, drawn indented under its family's row. */
  readonly nested: boolean;
  readonly onOpen: () => void;
  readonly onToggle: () => void;
}) {
  return (
    <Group gap={6} wrap="nowrap" pl={nested ? 'lg' : 0}>
      <UnstyledButton
        aria-label={`Open ${row.name}`}
        title={row.name}
        onClick={(event) => {
          // The row's own click does the same; one opening is enough.
          event.stopPropagation();
          onOpen();
        }}
        style={{ minWidth: 0, flexShrink: 0, maxWidth: 280 }}
      >
        <Text size="sm" fw={500} truncate>
          {row.name}
        </Text>
      </UnstyledButton>
      {row.status === ModelStatus.Current ? null : (
        <Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }}>
          {STATUS_LABEL[row.status]}
        </Text>
      )}
      {fresh && row.status === ModelStatus.Current ? (
        <Text size="xs" c="blue" style={{ whiteSpace: 'nowrap' }}>
          New
        </Text>
      ) : null}
      {older > 0 ? (
        <UnstyledButton
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} ${String(older)} older ${older === 1 ? 'version' : 'versions'} of ${row.name}`}
          onClick={(event) => {
            // Showing the older versions is not opening the model.
            event.stopPropagation();
            onToggle();
          }}
        >
          <Group gap={2} wrap="nowrap">
            {expanded ? (
              <IconChevronDown size={14} stroke={1.5} />
            ) : (
              <IconChevronRight size={14} stroke={1.5} />
            )}
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              {older} older
            </Text>
          </Group>
        </UnstyledButton>
      ) : null}
    </Group>
  );
}

/**
 * The model list as a calm table. Model, Intelligence, Cost per task and Steps run sort; the Model and Tier
 * headers filter it. A row, or Enter on its name, opens the drawer. `usedBy` names the roles whose pick a model
 * is, and `costNote` says what the cost per task is at, in that column's header.
 */
export function ModelsTable({
  families,
  paging,
  filter,
  onFilter,
  sort,
  onSort,
  now,
  earliest,
  usedBy,
  costNote,
  onOpen,
}: {
  /** The page's families; each lead is a row, its older versions open under it. */
  readonly families: readonly ModelFamily[];
  readonly paging: TablePage;
  readonly filter: ModelFilter;
  readonly onFilter: (next: ModelFilter) => void;
  readonly sort: ModelSort;
  readonly onSort: (next: ModelSort) => void;
  readonly now: number;
  readonly earliest: number | null;
  /** The labels of the roles that pick each model, by model ID. */
  readonly usedBy: ReadonlyMap<string, readonly string[]>;
  readonly costNote: string;
  readonly onOpen: (row: ModelRowDto) => void;
}) {
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const olderOf = new Map(families.map((f) => [f.lead.model, f.older]));
  const sortStatus: DataTableSortStatus<ModelRowDto> = {
    columnAccessor: sort.column,
    direction: sort.direction,
  };
  const onSortStatus = (next: DataTableSortStatus<ModelRowDto>): void => {
    if (!isModelColumn(next.columnAccessor)) return;
    onSort({
      column: next.columnAccessor,
      direction: next.direction === 'asc' ? SortDirection.Ascending : SortDirection.Descending,
    });
  };
  const head = (column: DataTableColumn<ModelRowDto>) =>
    withColumnHeader(column, sortStatus, onSortStatus);
  const numeric = (
    accessor: ModelColumn,
    title: string,
    value: (row: ModelRowDto) => ReactNode,
  ): DataTableColumn<ModelRowDto> =>
    head({
      accessor,
      title,
      textAlign: 'right',
      noWrap: true,
      sortable: true,
      cellsStyle: TABULAR,
      render: value,
    });
  const columns: DataTableColumn<ModelRowDto>[] = [
    head({
      accessor: ModelColumn.Name,
      title: 'Model',
      sortable: true,
      width: '100%',
      // Names stay readable; a table too wide for its frame scrolls inside it.
      cellsStyle: () => ({ minWidth: 200 }),
      filtering: filter.query.trim() !== '',
      filter: <ModelSearchFilter filter={filter} onFilter={onFilter} />,
      render: (row) => {
        const older = olderOf.get(row.model)?.length ?? 0;
        const open = expanded.includes(row.model);
        return (
          <ModelCell
            row={row}
            fresh={isNewModel(row, now, earliest)}
            older={older}
            expanded={open}
            nested={!olderOf.has(row.model)}
            onOpen={() => {
              onOpen(row);
            }}
            onToggle={() => {
              setExpanded((shown) =>
                shown.includes(row.model)
                  ? shown.filter((m) => m !== row.model)
                  : [...shown, row.model],
              );
            }}
          />
        );
      },
    }),
    head({
      accessor: ModelColumn.Tier,
      title: 'Tier',
      noWrap: true,
      filtering: filter.tiers.length > 0,
      filter: <TierFilter filter={filter} onFilter={onFilter} />,
      render: (row) => (
        <Text size="sm" c="dimmed">
          {row.tier === null ? NO_DATA : TIER_LABEL[row.tier]}
        </Text>
      ),
    }),
    numeric(ModelColumn.Intelligence, 'Intelligence', (row) => (
      <SourcedNumber
        text={formatScore(row.intelligence)}
        source={
          row.sources.intelligence === null
            ? null
            : modelSourceText(row.sources.intelligence, 'intelligence', null)
        }
      />
    )),
    {
      ...numeric(ModelColumn.CostPerTask, 'Cost per task', (row) => (
        <SourcedNumber
          text={formatCost(row.costPerTaskUsd)}
          source={
            row.sources.costPerTask === null
              ? null
              : modelSourceText(row.sources.costPerTask, 'costPerTask', null)
          }
        />
      )),
      title: (
        <Tooltip label={costNote} multiline maw={260} withArrow>
          <span>Cost per task</span>
        </Tooltip>
      ),
    },
    {
      accessor: 'usedBy',
      title: 'Used by',
      noWrap: true,
      render: (row) => {
        const own = (usedBy.get(row.model) ?? []).join(', ');
        // Folded, a family's row also says which roles run on a version under it.
        const hidden = expanded.includes(row.model)
          ? ''
          : (olderOf.get(row.model) ?? []).flatMap((r) => usedBy.get(r.model) ?? []).join(', ');
        return (
          <Group gap={6} wrap="nowrap" maw={220}>
            {own === '' ? null : (
              <Text size="xs" truncate title={own}>
                {own}
              </Text>
            )}
            {hidden === '' ? null : (
              <Text size="xs" c="dimmed" truncate title={`${hidden}, on an older version`}>
                {`${hidden}, on an older version`}
              </Text>
            )}
          </Group>
        );
      },
    },
    numeric(ModelColumn.StepsRun, 'Steps run', (row) => row.stepsRun),
  ];
  return (
    <DataTable<ModelRowDto>
      aria-label="Models"
      records={families.flatMap((f) =>
        expanded.includes(f.lead.model) ? [f.lead, ...f.older] : [f.lead],
      )}
      columns={columns}
      idAccessor={(row) => row.model}
      withTableBorder
      backgroundColor="var(--tendb-color-panel)"
      borderRadius="md"
      verticalSpacing="sm"
      horizontalSpacing="md"
      highlightOnHover
      {...pagerProps(paging, TABLE_PAGE_SIZES)}
      {...(families.length === 0 ? { minHeight: 160 } : {})}
      emptyState={
        <Text c="dimmed" size="sm" ta="center">
          No model matches these filters.
        </Text>
      }
      onRowClick={({ record }) => {
        onOpen(record);
      }}
    />
  );
}
