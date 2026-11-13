import { ModelStatus, type ModelRowDto } from '@10db/contracts';
import { Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { DataTable, type DataTableColumn, type DataTableSortStatus } from 'mantine-datatable';
import { withColumnHeader } from '../../shell/column-header';
import { ModelSearchFilter, TierFilter } from './model-filters';
import { formatCost, formatScore, NO_DATA } from './model-format';
import { STATUS_LABEL, TIER_LABEL } from './model-labels';
import {
  isNewModel,
  ModelColumn,
  SortDirection,
  type ModelFilter,
  type ModelSort,
} from './model-order';
import { PICK_COLOR } from './role-picks-panel';

const isModelColumn = (value: unknown): value is ModelColumn =>
  Object.values(ModelColumn).some((c) => c === value);

const TABULAR = () => ({ fontVariantNumeric: 'tabular-nums' });

/** The name on one line, then its status as dimmed text, and New in blue. The button is the keyboard's way to a row's click. */
function ModelCell({
  row,
  fresh,
  onOpen,
}: {
  readonly row: ModelRowDto;
  readonly fresh: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <Group gap={6} wrap="nowrap">
      <UnstyledButton
        aria-label={`Open ${row.name}`}
        title={row.name}
        onClick={(event) => {
          // The row's own click does the same; one opening is enough.
          event.stopPropagation();
          onOpen();
        }}
        style={{ minWidth: 0 }}
      >
        <Text size="sm" fw={500} truncate>
          {row.name}
        </Text>
      </UnstyledButton>
      {row.status === ModelStatus.Current ? null : (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {STATUS_LABEL[row.status]}
        </Text>
      )}
      {fresh ? (
        <Text size="xs" c="blue" style={{ whiteSpace: 'nowrap' }}>
          New
        </Text>
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
  rows,
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
  readonly rows: readonly ModelRowDto[];
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
    value: (row: ModelRowDto) => string | number,
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
      ellipsis: true,
      filtering: filter.query.trim() !== '',
      filter: <ModelSearchFilter filter={filter} onFilter={onFilter} />,
      render: (row) => (
        <ModelCell
          row={row}
          fresh={isNewModel(row, now, earliest)}
          onOpen={() => {
            onOpen(row);
          }}
        />
      ),
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
    numeric(ModelColumn.Intelligence, 'Intelligence', (row) => formatScore(row.intelligence)),
    {
      ...numeric(ModelColumn.CostPerTask, 'Cost per task', (row) => formatCost(row.costPerTaskUsd)),
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
      render: (row) => (
        <Text size="xs" c={PICK_COLOR}>
          {(usedBy.get(row.model) ?? []).join(', ')}
        </Text>
      ),
    },
    numeric(ModelColumn.StepsRun, 'Steps run', (row) => row.stepsRun),
  ];
  return (
    <DataTable<ModelRowDto>
      aria-label="Models"
      records={[...rows]}
      columns={columns}
      idAccessor={(row) => row.model}
      withTableBorder
      borderRadius="md"
      verticalSpacing="sm"
      horizontalSpacing="md"
      highlightOnHover
      {...(rows.length === 0 ? { minHeight: 160 } : {})}
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
