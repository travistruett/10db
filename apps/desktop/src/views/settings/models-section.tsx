import type { ModelRowDto } from '@10db/contracts';
import { Button, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useDataTableColumns } from 'mantine-datatable';
import { useState } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import {
  useCatalogueStatus,
  useModelOffers,
  useModels,
  useRefreshModels,
} from '../../daemon/model-queries';
import { columnChoices, ColumnsMenu, hiddenColumns, toggleColumn } from '../../shell/columns-menu';
import { useNow } from '../../shell/relative';
import { ArtificialAnalysisCredit } from './artificial-analysis-credit';
import { ArtificialAnalysisStatusLine } from './artificial-analysis-status-line';
import { ModelDrawer } from './model-drawer';
import { catalogueLine, costNote } from './model-format';
import {
  filterModels,
  earliestFirstSeen,
  ModelColumn,
  SortDirection,
  sortModels,
  type ModelFilter,
  type ModelSort,
} from './model-order';
import { ModelsChartView } from './models-chart-view';
import { ModelsTable, TOGGLEABLE_COLUMNS } from './models-table';

const View = { Table: 'table', Chart: 'chart' } as const;
type View = (typeof View)[keyof typeof View];

const isView = (value: string): value is View => Object.values(View).some((v) => v === value);

const NO_FILTER: ModelFilter = { query: '', tiers: [], accountId: null };

/** Every model 10db can reach, with its tier, price and scores, and where the catalogue behind it came from. */
export function ModelsSection() {
  const now = useNow();
  const [filter, setFilter] = useState<ModelFilter>(NO_FILTER);
  const models = useModels(filter.accountId);
  const offers = useModelOffers();
  const layout = useDataTableColumns<ModelRowDto>({
    key: 'models-table',
    columns: TOGGLEABLE_COLUMNS,
  });
  const status = useCatalogueStatus();
  const accounts = useAccounts();
  const refresh = useRefreshModels();
  const [view, setView] = useState<View>(View.Table);
  const [sort, setSort] = useState<ModelSort>({
    column: ModelColumn.Tier,
    direction: SortDirection.Descending,
  });
  const [selected, setSelected] = useState<ModelRowDto | null>(null);
  const [opened, setOpened] = useState(false);

  if (models.isPending) return <Text c="dimmed">Loading models…</Text>;
  // A failed read for one account leaves the toolbar, so the filter can be put back.
  const failedForAccount = models.data === undefined && filter.accountId !== null;
  if (models.data === undefined && !failedForAccount)
    return <Text c="red">Models could not be loaded. Check that the daemon is running.</Text>;

  const live = (accounts.data ?? []).filter((a) => !a.archived);
  const labels = new Map((accounts.data ?? []).map((a) => [a.id, a.label]));
  const data = models.data ?? [];
  const earliest = earliestFirstSeen(data);
  const rows = sortModels(filterModels(data, filter), sort);
  const chartAccount = live.find((a) => a.id === filter.accountId)?.id ?? null;
  return (
    <Stack>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            {status.data !== undefined
              ? catalogueLine(status.data, now)
              : status.isError
                ? 'The catalogue status could not be read.'
                : 'Reading the catalogue…'}
          </Text>
          <ArtificialAnalysisStatusLine />
          {view === View.Table ? <ArtificialAnalysisCredit /> : null}
        </Stack>
        <Group gap="xs" wrap="nowrap">
          {refresh.isError ? (
            <Text size="xs" c="red" role="alert">
              {refresh.error.message}
            </Text>
          ) : null}
          <SegmentedControl
            size="xs"
            aria-label="View"
            data={[
              { value: View.Table, label: 'Table' },
              { value: View.Chart, label: 'Chart' },
            ]}
            value={view}
            onChange={(value) => {
              if (isView(value)) setView(value);
            }}
          />
          {view === View.Table ? (
            <ColumnsMenu
              choices={columnChoices(TOGGLEABLE_COLUMNS, layout.columnsToggle)}
              onToggle={(accessor) => {
                layout.setColumnsToggle(
                  toggleColumn(TOGGLEABLE_COLUMNS, layout.columnsToggle, accessor),
                );
              }}
            />
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
      {failedForAccount ? (
        <Group gap="sm">
          <Text c="red" role="alert">
            The models of this account could not be read.
          </Text>
          <Button
            variant="default"
            size="xs"
            onClick={() => {
              // The chart would take the default account again, so the Table is where every account shows.
              setView(View.Table);
              setFilter({ ...filter, accountId: null });
            }}
          >
            Show every account
          </Button>
        </Group>
      ) : data.length === 0 ? (
        <Text c="dimmed">
          No models yet. They appear once an account has been read; Refresh Models reads every
          account now.
        </Text>
      ) : view === View.Chart ? (
        <ModelsChartView
          rows={rows}
          names={new Map(data.map((r) => [r.model, r.name]))}
          accounts={live}
          accountId={chartAccount}
          accountsReady={!accounts.isPending}
          onAccount={(id) => {
            setFilter({ ...filter, accountId: id });
          }}
          settling={models.isPlaceholderData}
        />
      ) : (
        <ModelsTable
          rows={rows}
          accounts={live}
          accountLabels={labels}
          filter={filter}
          onFilter={setFilter}
          sort={sort}
          onSort={setSort}
          now={now}
          earliest={earliest}
          hidden={hiddenColumns(TOGGLEABLE_COLUMNS, layout.columnsToggle)}
          costNote={costNote(
            live.find((a) => a.id === filter.accountId) ?? null,
            offers.data ?? [],
          )}
          onOpen={(r) => {
            setSelected(r);
            setOpened(true);
          }}
        />
      )}
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
