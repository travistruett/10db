import { AccountId, ModelStatus, ModelTier, type ModelRowDto } from '@10db/contracts';
import {
  Badge,
  Button,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import { useCatalogueStatus, useModels, useRefreshModels } from '../../daemon/model-queries';
import { useNow } from '../../shell/relative';
import { ArtificialAnalysisCredit } from './artificial-analysis-credit';
import { ModelDrawer } from './model-drawer';
import { STATUS_LABEL, TIER_LABEL } from './model-labels';
import { catalogueLine, formatPrice, formatScore, NO_DATA } from './model-format';
import {
  filterModels,
  earliestFirstSeen,
  isNewModel,
  ModelColumn,
  SortDirection,
  sortModels,
  type ModelSort,
} from './model-order';

const ALL = 'all';
const ALL_ACCOUNTS = 'all-accounts';

const TIER_CHOICES = [
  { value: ALL, label: 'All' },
  ...Object.values(ModelTier).map((tier) => ({ value: tier, label: TIER_LABEL[tier] })),
];

const isTier = (value: string): value is ModelTier =>
  Object.values(ModelTier).some((t) => t === value);

interface ColumnSpec {
  readonly column: ModelColumn;
  readonly label: string;
  readonly numeric: boolean;
}

const COLUMNS: readonly ColumnSpec[] = [
  { column: ModelColumn.Name, label: 'Model', numeric: false },
  { column: ModelColumn.Tier, label: 'Tier', numeric: false },
  { column: ModelColumn.AvailableOn, label: 'Available on', numeric: false },
  { column: ModelColumn.Intelligence, label: 'Intelligence', numeric: true },
  { column: ModelColumn.Coding, label: 'Coding', numeric: true },
  { column: ModelColumn.Speed, label: 'Speed (tokens/s)', numeric: true },
  { column: ModelColumn.InputPrice, label: 'Input', numeric: true },
  { column: ModelColumn.OutputPrice, label: 'Output', numeric: true },
  { column: ModelColumn.StepsRun, label: 'Steps run', numeric: true },
];

function SortableHeader({
  spec,
  sort,
  onSort,
}: {
  readonly spec: ColumnSpec;
  readonly sort: ModelSort;
  readonly onSort: (column: ModelColumn) => void;
}) {
  const active = sort.column === spec.column;
  const ariaSort = !active
    ? 'none'
    : sort.direction === SortDirection.Ascending
      ? 'ascending'
      : 'descending';
  return (
    <Table.Th aria-sort={ariaSort} {...(spec.numeric ? { ta: 'right' as const } : {})}>
      <UnstyledButton
        onClick={() => {
          onSort(spec.column);
        }}
      >
        <Group gap={4} wrap="nowrap" justify={spec.numeric ? 'flex-end' : 'flex-start'}>
          <Text size="sm" fw={500} component="span">
            {spec.label}
          </Text>
          {active ? (
            sort.direction === SortDirection.Ascending ? (
              <IconArrowUp size={14} stroke={1.5} aria-hidden />
            ) : (
              <IconArrowDown size={14} stroke={1.5} aria-hidden />
            )
          ) : null}
        </Group>
      </UnstyledButton>
    </Table.Th>
  );
}

function ModelTableRow({
  row,
  accountLabels,
  now,
  earliest,
  onOpen,
}: {
  readonly row: ModelRowDto;
  readonly accountLabels: ReadonlyMap<string, string>;
  readonly now: number;
  readonly earliest: number | null;
  readonly onOpen: (row: ModelRowDto) => void;
}) {
  const statusBadge = row.status === ModelStatus.Current ? null : STATUS_LABEL[row.status];
  const fresh = isNewModel(row, now, earliest);
  const accounts = row.availableOn.map((id) => accountLabels.get(id) ?? 'Removed account');
  return (
    <Table.Tr>
      <Table.Td>
        <Stack gap={2}>
          <Group gap="xs" wrap="nowrap">
            <UnstyledButton
              aria-label={`Open ${row.name}`}
              onClick={() => {
                onOpen(row);
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
      </Table.Td>
      <Table.Td>{row.tier === null ? NO_DATA : TIER_LABEL[row.tier]}</Table.Td>
      <Table.Td>{accounts.length === 0 ? NO_DATA : accounts.join(', ')}</Table.Td>
      <Table.Td ta="right">{formatScore(row.intelligence)}</Table.Td>
      <Table.Td ta="right">{formatScore(row.coding)}</Table.Td>
      <Table.Td ta="right">{formatScore(row.outputTokensPerSecond)}</Table.Td>
      <Table.Td ta="right">{formatPrice(row.inputPrice)}</Table.Td>
      <Table.Td ta="right">{formatPrice(row.outputPrice)}</Table.Td>
      <Table.Td ta="right">{row.stepsRun}</Table.Td>
    </Table.Tr>
  );
}

/** Every model 10db can reach, with its tier, price and scores, and where the catalogue behind it came from. */
export function ModelsSection() {
  const now = useNow();
  const models = useModels();
  const status = useCatalogueStatus();
  const accounts = useAccounts();
  const refresh = useRefreshModels();
  const [tier, setTier] = useState<ModelTier | null>(null);
  const [accountId, setAccountId] = useState<AccountId | null>(null);
  const [sort, setSort] = useState<ModelSort>({
    column: ModelColumn.Tier,
    direction: SortDirection.Descending,
  });
  const [selected, setSelected] = useState<ModelRowDto | null>(null);
  const [opened, setOpened] = useState(false);

  if (models.isPending) return <Text c="dimmed">Loading models…</Text>;
  if (models.data === undefined)
    return <Text c="red">Models could not be loaded. Check that the daemon is running.</Text>;

  const live = (accounts.data ?? []).filter((a) => !a.archived);
  const labels = new Map((accounts.data ?? []).map((a) => [a.id, a.label]));
  const earliest = earliestFirstSeen(models.data);
  const rows = sortModels(filterModels(models.data, { tier, accountId }), sort);
  const onSort = (column: ModelColumn) => {
    setSort((current) =>
      current.column === column
        ? {
            column,
            direction:
              current.direction === SortDirection.Ascending
                ? SortDirection.Descending
                : SortDirection.Ascending,
          }
        : { column, direction: SortDirection.Ascending },
    );
  };

  return (
    <Stack>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Text size="xs" c="dimmed">
          {status.data !== undefined
            ? catalogueLine(status.data, now)
            : status.isError
              ? 'The catalogue status could not be read.'
              : 'Reading the catalogue…'}
        </Text>
        <Group gap="xs" wrap="nowrap">
          {refresh.isError ? (
            <Text size="xs" c="red" role="alert">
              {refresh.error.message}
            </Text>
          ) : null}
          <Button
            variant="default"
            size="xs"
            leftSection={<IconRefresh size={16} stroke={1.5} />}
            loading={refresh.isPending}
            onClick={() => {
              refresh.mutate();
            }}
          >
            Refresh Models
          </Button>
        </Group>
      </Group>
      <Group gap="md">
        <SegmentedControl
          aria-label="Tier"
          value={tier ?? ALL}
          data={TIER_CHOICES}
          onChange={(value) => {
            setTier(isTier(value) ? value : null);
          }}
        />
        <Select
          aria-label="Account"
          w={240}
          allowDeselect={false}
          value={accountId ?? ALL_ACCOUNTS}
          data={[
            { value: ALL_ACCOUNTS, label: 'All accounts' },
            ...live.map((a) => ({ value: a.id, label: a.label })),
          ]}
          onChange={(value) => {
            const parsed = AccountId.safeParse(value);
            setAccountId(parsed.success ? parsed.data : null);
          }}
        />
      </Group>
      {models.data.length === 0 ? (
        <Text c="dimmed">
          No models yet. They appear once an account has been read; Refresh Models reads every
          account now.
        </Text>
      ) : (
        <Table aria-label="Models" verticalSpacing="sm" tabularNums>
          <Table.Thead>
            <Table.Tr>
              <Table.Th colSpan={3} />
              <Table.Th colSpan={3} ta="right">
                <ArtificialAnalysisCredit />
              </Table.Th>
              <Table.Th colSpan={2} ta="right">
                <Text size="xs" c="dimmed" fw={400}>
                  Price per 1M tokens
                </Text>
              </Table.Th>
              <Table.Th />
            </Table.Tr>
            <Table.Tr>
              {COLUMNS.map((spec) => (
                <SortableHeader key={spec.column} spec={spec} sort={sort} onSort={onSort} />
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <ModelTableRow
                key={row.model}
                row={row}
                accountLabels={labels}
                now={now}
                earliest={earliest}
                onOpen={(r) => {
                  setSelected(r);
                  setOpened(true);
                }}
              />
            ))}
          </Table.Tbody>
        </Table>
      )}
      {models.data.length > 0 && rows.length === 0 ? (
        <Text c="dimmed">No model matches these filters.</Text>
      ) : null}
      <ModelDrawer
        row={selected}
        opened={opened}
        now={now}
        onClose={() => {
          setOpened(false);
        }}
      />
    </Stack>
  );
}
