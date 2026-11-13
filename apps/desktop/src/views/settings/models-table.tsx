import { ModelStatus, type AccountDto, type ModelRowDto } from '@10db/contracts';
import { Badge, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import {
  DataTable,
  type DataTableColumn,
  type DataTableColumnGroup,
  type DataTableSortStatus,
} from 'mantine-datatable';
import { withColumnHeader } from '../../shell/column-header';
import { ArtificialAnalysisCredit } from './artificial-analysis-credit';
import { AccountFilter, ModelSearchFilter, TierFilter } from './model-filters';
import { formatPrice, formatScore, NO_DATA } from './model-format';
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

/** The name, model ID and badges of a row; its button is the keyboard's way to what a row click does. */
function ModelCell({
  row,
  fresh,
  onOpen,
}: {
  readonly row: ModelRowDto;
  readonly fresh: boolean;
  readonly onOpen: () => void;
}) {
  const statusBadge = row.status === ModelStatus.Current ? null : STATUS_LABEL[row.status];
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="nowrap">
        <UnstyledButton
          aria-label={`Open ${row.name}`}
          onClick={(event) => {
            // The row's own click does the same; one opening is enough.
            event.stopPropagation();
            onOpen();
          }}
        >
          <Text size="sm" fw={500}>
            {row.name}
          </Text>
        </UnstyledButton>
        {fresh ? (
          <Badge size="sm" variant="light" color="blue">
            New
          </Badge>
        ) : null}
        {statusBadge ? (
          <Badge size="sm" variant="light" color="gray">
            {statusBadge}
          </Badge>
        ) : null}
      </Group>
      <Text size="xs" c="dimmed" ff="monospace">
        {row.model}
      </Text>
    </Stack>
  );
}

const numeric = (
  accessor: ModelColumn,
  title: string,
  value: (row: ModelRowDto) => string | number,
): DataTableColumn<ModelRowDto> => ({
  accessor,
  title,
  textAlign: 'right',
  noWrap: true,
  sortable: true,
  render: value,
});

/**
 * The model list as a table. Every column sorts; the Model, Tier and Available on columns filter it from
 * their headers. The scores carry Artificial Analysis's credit over them, the prices their unit. Clicking a
 * row opens it.
 */
export function ModelsTable({
  rows,
  accounts,
  accountLabels,
  filter,
  onFilter,
  sort,
  onSort,
  now,
  earliest,
  onOpen,
}: {
  readonly rows: readonly ModelRowDto[];
  /** The accounts the Available on filter offers. */
  readonly accounts: readonly AccountDto[];
  readonly accountLabels: ReadonlyMap<string, string>;
  readonly filter: ModelFilter;
  readonly onFilter: (next: ModelFilter) => void;
  readonly sort: ModelSort;
  readonly onSort: (next: ModelSort) => void;
  readonly now: number;
  readonly earliest: number | null;
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
  const described: DataTableColumn<ModelRowDto>[] = [
    {
      accessor: ModelColumn.Name,
      title: 'Model',
      sortable: true,
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
    },
    {
      accessor: ModelColumn.Tier,
      title: 'Tier',
      noWrap: true,
      sortable: true,
      filtering: filter.tiers.length > 0,
      filter: <TierFilter filter={filter} onFilter={onFilter} />,
      render: (row) => (row.tier === null ? NO_DATA : TIER_LABEL[row.tier]),
    },
    {
      accessor: ModelColumn.AvailableOn,
      title: 'Available on',
      sortable: true,
      filtering: filter.accountId !== null,
      filter: <AccountFilter filter={filter} onFilter={onFilter} accounts={accounts} />,
      render: (row) => {
        const names = row.availableOn.map((id) => accountLabels.get(id) ?? 'Removed account');
        return names.length === 0 ? NO_DATA : names.join(', ');
      },
    },
  ];
  const groups: DataTableColumnGroup<ModelRowDto>[] = [
    { id: 'model', title: '', columns: described.map(head) },
    {
      id: 'scores',
      title: <ArtificialAnalysisCredit />,
      textAlign: 'right',
      columns: [
        numeric(ModelColumn.Intelligence, 'Intelligence', (row) => formatScore(row.intelligence)),
        numeric(ModelColumn.Speed, 'Speed (tokens/s)', (row) =>
          formatScore(row.outputTokensPerSecond),
        ),
      ].map(head),
    },
    {
      id: 'prices',
      title: (
        <Text size="xs" c="dimmed" fw={400}>
          Price per 1M tokens
        </Text>
      ),
      textAlign: 'right',
      columns: [
        numeric(ModelColumn.InputPrice, 'Input', (row) => formatPrice(row.inputPrice)),
        numeric(ModelColumn.OutputPrice, 'Output', (row) => formatPrice(row.outputPrice)),
      ].map(head),
    },
    {
      id: 'use',
      title: '',
      columns: [numeric(ModelColumn.StepsRun, 'Steps run', (row) => row.stepsRun)].map(head),
    },
  ];
  return (
    <DataTable<ModelRowDto>
      aria-label="Models"
      records={[...rows]}
      groups={groups}
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
