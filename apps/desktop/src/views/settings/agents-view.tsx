import { RIGORS, Rigor, type AccountDto, type ModelRowDto, type StepRole } from '@10db/contracts';
import { Button, Group, SegmentedControl, Select, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { useModelOffers, useModelPicks, useModels } from '../../daemon/model-queries';
import { usePlaybook } from '../../daemon/playbook-queries';
import { useNow } from '../../shell/relative';
import { TABLE_PAGE_SIZES, usePaging } from '../../shell/table-pager';
import { ModelDrawer } from './model-drawer';
import { groupByFamily } from './model-families';
import { costNote } from './model-format';
import {
  earliestFirstSeen,
  filterModels,
  ModelColumn,
  SortDirection,
  sortModels,
  type ModelFilter,
  type ModelSort,
} from './model-order';
import { KindsSection } from './kinds-section';
import { MoveReportNote } from './move-report-note';
import { ModelsTable } from './models-table';
import { PlaybookTable } from './playbook-table';
import { rigorLabel } from './rigor-labels';
import { RaisedPanel } from './raised-panel';
import { RightsizingChart } from './rightsizing-chart';
import { DotsMode, rightsizingSeries } from './rightsizing-series';
import { ROLES } from './role-labels';

const NO_FILTER: ModelFilter = { query: '', tiers: [], accountId: null };

const DOTS_LABELS = [
  { value: DotsMode.Every, label: 'Every effort' },
  { value: DotsMode.Frontier, label: 'Frontier only' },
] as const;

const isDotsMode = (value: string): value is DotsMode =>
  Object.values(DotsMode).some((mode) => mode === value);

const isRigor = (value: string): value is Rigor => RIGORS.some((r) => r === value);

const roleLabel = (role: StepRole): string => ROLES.find((r) => r.role === role)?.label ?? role;

/**
 * Models › Agents: the playbook and the kinds on one account, then Intelligence against cost per task with the
 * picks of one rigor drawn on it, then every model the account runs. A model's detail is in the drawer.
 */
export function AgentsView({ account }: { readonly account: AccountDto }) {
  const now = useNow();
  const accountId = account.id;
  const models = useModels(accountId);
  // The chart's rings follow one rigor; Standard is the one most work gets.
  const [rigor, setRigor] = useState<Rigor>(Rigor.Standard);
  const picks = useModelPicks(accountId, rigor, null);
  const playbook = usePlaybook(null);
  const offers = useModelOffers();
  const [filter, setFilter] = useState<ModelFilter>(NO_FILTER);
  const [sort, setSort] = useState<ModelSort>({
    column: ModelColumn.Intelligence,
    direction: SortDirection.Descending,
  });
  const [dots, setDots] = useState<DotsMode>(DotsMode.Every);
  const [selected, setSelected] = useState<ModelRowDto | null>(null);
  const [opened, setOpened] = useState(false);
  // The list goes back to its first page whenever what it holds or its order changes.
  const paging = usePaging(JSON.stringify([filter, sort, accountId]), TABLE_PAGE_SIZES[0]);

  if (models.isError)
    return (
      <Stack>
        <Group gap="sm">
          <Text c="red" role="alert">
            {models.error.message}
          </Text>
          <Button
            variant="default"
            size="xs"
            onClick={() => {
              void models.refetch();
            }}
          >
            Try Again
          </Button>
        </Group>
      </Stack>
    );
  if (models.data === undefined)
    return (
      <Stack>
        <Text c="dimmed">Loading models…</Text>
      </Stack>
    );

  const everyModel = models.data;
  // Rows of another account stay up while this one loads; no ring is drawn on a price that is not this account's.
  const settling = models.isPlaceholderData;
  const accountRows = filterModels(everyModel, { ...NO_FILTER, accountId });
  const families = groupByFamily(
    sortModels(filterModels(everyModel, { ...filter, accountId }), sort),
  );
  // A refresh can shrink the list under the page; the page shown is never past the last one.
  const page = Math.min(paging.page, Math.max(1, Math.ceil(families.length / paging.pageSize)));
  const shownFamilies = families.slice((page - 1) * paging.pageSize, page * paging.pageSize);
  // Only the roles the rigor's row runs are ringed and counted as using a model.
  const runs = playbook.data?.rows.find((r) => r.rigor === rigor)?.steps.value ?? null;
  const drawnPicks = settling
    ? []
    : (picks.data?.picks ?? []).filter((p) => runs === null || runs.includes(p.role));
  const result = rightsizingSeries({ rows: accountRows, picks: drawnPicks, role: null, dots });
  const usedBy = new Map<string, string[]>();
  for (const pick of drawnPicks)
    if (pick.model !== null)
      usedBy.set(pick.model, [...(usedBy.get(pick.model) ?? []), roleLabel(pick.role)]);
  const note = costNote(account, offers.data ?? []);
  return (
    <Stack gap="lg">
      <MoveReportNote />
      <Stack gap="xs" component="section" aria-label="Playbook section">
        <Title order={4} size="md" fw={600}>
          Playbook
        </Title>
        <Text size="xs" c="dimmed">
          Each rigor runs the steps in its row. A cell shows the model and effort it resolves to on{' '}
          {account.label}, and the setting behind it; open a cell to change it, a rigor to change
          its steps.
        </Text>
        <PlaybookTable projectId={null} accountId={accountId} />
      </Stack>
      <KindsSection />
      <Stack gap="xs">
        <Group justify="space-between">
          <Title order={4} size="md" fw={600}>
            Intelligence and cost
          </Title>
          <Group gap="xs" wrap="nowrap">
            <Select
              aria-label="Rigor for the rings"
              size="xs"
              w={190}
              leftSection={
                <Text size="xs" c="dimmed">
                  Rings
                </Text>
              }
              leftSectionWidth={56}
              leftSectionPointerEvents="none"
              allowDeselect={false}
              data={RIGORS.map((r) => ({ value: r, label: rigorLabel(r) }))}
              value={rigor}
              onChange={(value) => {
                if (value !== null && isRigor(value)) setRigor(value);
              }}
            />
            <SegmentedControl
              size="xs"
              aria-label="Dots"
              data={[...DOTS_LABELS]}
              value={dots}
              onChange={(value) => {
                if (isDotsMode(value)) setDots(value);
              }}
            />
          </Group>
        </Group>
        <RaisedPanel>
          <RightsizingChart
            result={result}
            costLabel={`Cost per task (USD, log scale). ${note}`}
            height={300}
          />
        </RaisedPanel>
        <Text size="xs" c="dimmed">
          Blue: the most Intelligence for its cost. Rings: each role&apos;s pick on this account at
          the rigor chosen.
          {result.omitted > 0
            ? ` ${String(result.omitted)} ${result.omitted === 1 ? 'effort' : 'efforts'} with no score yet ${result.omitted === 1 ? 'is' : 'are'} not drawn.`
            : ''}
        </Text>
      </Stack>
      <Stack gap="xs">
        <Title order={4} size="md" fw={600}>
          All models
        </Title>
        {everyModel.length === 0 ? (
          <Text c="dimmed">
            No models yet. They appear once an account has been read; the refresh button reads every
            account now.
          </Text>
        ) : (
          <ModelsTable
            families={shownFamilies}
            paging={{ ...paging, page, total: families.length }}
            filter={filter}
            onFilter={setFilter}
            sort={sort}
            onSort={setSort}
            now={now}
            earliest={earliestFirstSeen(everyModel)}
            usedBy={usedBy}
            costNote={note}
            onOpen={(r) => {
              setSelected(r);
              setOpened(true);
            }}
          />
        )}
      </Stack>
      <ModelDrawer
        row={selected}
        opened={opened}
        now={now}
        picks={drawnPicks}
        account={accountId}
        onClose={() => {
          setOpened(false);
        }}
      />
    </Stack>
  );
}
