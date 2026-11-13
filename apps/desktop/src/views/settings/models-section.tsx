import type { ModelRowDto } from '@10db/contracts';
import { Button, Group, Stack, Text } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import { useCatalogueStatus, useModels, useRefreshModels } from '../../daemon/model-queries';
import { useNow } from '../../shell/relative';
import { ModelDrawer } from './model-drawer';
import { catalogueLine } from './model-format';
import {
  filterModels,
  earliestFirstSeen,
  ModelColumn,
  SortDirection,
  sortModels,
  type ModelFilter,
  type ModelSort,
} from './model-order';
import { ModelsTable } from './models-table';

const NO_FILTER: ModelFilter = { query: '', tiers: [], accountId: null };

/** Every model 10db can reach, with its tier, price and scores, and where the catalogue behind it came from. */
export function ModelsSection() {
  const now = useNow();
  const models = useModels();
  const status = useCatalogueStatus();
  const accounts = useAccounts();
  const refresh = useRefreshModels();
  const [filter, setFilter] = useState<ModelFilter>(NO_FILTER);
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
  const rows = sortModels(filterModels(models.data, filter), sort);

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
      {models.data.length === 0 ? (
        <Text c="dimmed">
          No models yet. They appear once an account has been read; Refresh Models reads every
          account now.
        </Text>
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
