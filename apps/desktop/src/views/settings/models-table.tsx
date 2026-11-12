import { ModelStatus, type AccountDto, type ModelRowDto } from '@10db/contracts';
import {
  ActionIcon,
  Badge,
  Group,
  Stack,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { DataTable, type DataTableColumn, type DataTableSortStatus } from 'mantine-datatable';
import { useState } from 'react';
import { withColumnHeader } from '../../shell/column-header';
import { AccountFilter, ModelSearchFilter, TierFilter } from './model-filters';
import { formatCost, formatFirstPass, formatPrice, formatScore, NO_DATA } from './model-format';
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
  expanded,
  onOpen,
  onExpand,
}: {
  readonly row: ModelRowDto;
  readonly fresh: boolean;
  readonly expanded: boolean;
  readonly onOpen: () => void;
  readonly onExpand: () => void;
}) {
  const statusBadge = row.status === ModelStatus.Current ? null : STATUS_LABEL[row.status];
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="nowrap">
        {row.efforts.length === 0 ? null : (
          <ActionIcon
            variant="subtle"
            size="xs"
            aria-label={`${expanded ? 'Hide' : 'Show'} efforts of ${row.name}`}
            aria-expanded={expanded}
            onClick={(event) => {
              // The row's own click opens the drawer; the chevron only opens the efforts.
              event.stopPropagation();
              onExpand();
            }}
          >
            <IconChevronRight
              size={14}
              stroke={1.5}
              style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
            />
          </ActionIcon>
        )}
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

/** One line per effort of an expanded row. */
function EffortLines({ row }: { readonly row: ModelRowDto }) {
  return (
    <Table aria-label={`Efforts of ${row.name}`} verticalSpacing="xs" withRowBorders={false}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Effort</Table.Th>
          <Table.Th ta="right">Intelligence</Table.Th>
          <Table.Th ta="right">Cost per task</Table.Th>
          <Table.Th ta="right">Steps run</Table.Th>
          <Table.Th ta="right">First pass</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {row.efforts.map((e) => (
          <Table.Tr key={e.profileId}>
            <Table.Td>{e.effort}</Table.Td>
            <Table.Td ta="right">{formatScore(e.intelligence)}</Table.Td>
            <Table.Td ta="right">{formatCost(e.costPerTaskUsd)}</Table.Td>
            <Table.Td ta="right">{e.stepsRun}</Table.Td>
            <Table.Td ta="right">{formatFirstPass(e.firstPassSteps, e.stepsRun)}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** The columns the Columns menu can hide, which the section keeps the layout of. */
export const TOGGLEABLE_COLUMNS: DataTableColumn<ModelRowDto>[] = [
  {
    accessor: ModelColumn.Speed,
    title: 'Speed (tokens/s)',
    toggleable: true,
    defaultToggle: false,
  },
];

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
 * their headers. A row's chevron expands it to one line per effort, and clicking elsewhere on it opens it.
 * `hidden` names the columns the Columns menu has switched off, and `costNote` says what the cost per task is
 * at, in that column's header.
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
  hidden,
  costNote,
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
  readonly hidden: ReadonlySet<string>;
  readonly costNote: string;
  readonly onOpen: (row: ModelRowDto) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<unknown[]>([]);
  const toggleExpanded = (model: string): void => {
    setExpandedIds((ids) =>
      ids.includes(model) ? ids.filter((id) => id !== model) : [...ids, model],
    );
  };
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
          expanded={expandedIds.includes(row.model)}
          onOpen={() => {
            onOpen(row);
          }}
          onExpand={() => {
            toggleExpanded(row.model);
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
  const cost = head(
    numeric(ModelColumn.CostPerTask, 'Cost per task', (row) => formatCost(row.costPerTaskUsd)),
  );
  const columns: DataTableColumn<ModelRowDto>[] = [
    ...described.map(head),
    head(numeric(ModelColumn.Intelligence, 'Intelligence', (row) => formatScore(row.intelligence))),
    {
      ...cost,
      title: (
        <Tooltip label={costNote} multiline maw={260} withArrow>
          <span>{cost.title}</span>
        </Tooltip>
      ),
    },
    head(numeric(ModelColumn.InputPrice, 'Input $/1M', (row) => formatPrice(row.inputPrice))),
    head(numeric(ModelColumn.OutputPrice, 'Output $/1M', (row) => formatPrice(row.outputPrice))),
    head(numeric(ModelColumn.StepsRun, 'Steps run', (row) => row.stepsRun)),
    {
      ...head(
        numeric(ModelColumn.Speed, 'Speed (tokens/s)', (row) =>
          formatScore(row.outputTokensPerSecond),
        ),
      ),
      hidden: hidden.has(ModelColumn.Speed),
    },
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
      rowExpansion={{
        trigger: 'never',
        expandable: ({ record }) => record.efforts.length > 0,
        expanded: { recordIds: expandedIds, onRecordIdsChange: setExpandedIds },
        content: ({ record }) => <EffortLines row={record} />,
      }}
      onRowClick={({ record }) => {
        onOpen(record);
      }}
    />
  );
}
