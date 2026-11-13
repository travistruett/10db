import { RIGORS, Rigor, type AccountId, type ModelRowDto, type StepRole } from '@10db/contracts';
import {
  ActionIcon,
  Anchor,
  Button,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import {
  useCatalogueStatus,
  useModelOffers,
  useModelPicks,
  useModels,
  useRefreshModels,
} from '../../daemon/model-queries';
import { useNow } from '../../shell/relative';
import { ArtificialAnalysisCredit } from './artificial-analysis-credit';
import { ArtificialAnalysisStatusLine } from './artificial-analysis-status-line';
import { TABLE_PAGE_SIZES, usePaging } from '../../shell/table-pager';
import { ModelDrawer } from './model-drawer';
import { groupByFamily } from './model-families';
import { catalogueLine, costNote } from './model-format';
import {
  earliestFirstSeen,
  filterModels,
  ModelColumn,
  SortDirection,
  sortModels,
  type ModelFilter,
  type ModelSort,
} from './model-order';
import { MoveReportNote } from './move-report-note';
import { ModelsTable } from './models-table';
import { PlaybookTable } from './playbook-table';
import { rigorLabel } from './rigor-labels';
import { RaisedPanel } from './raised-panel';
import { RightsizingChart } from './rightsizing-chart';
import { DotsMode, rightsizingSeries } from './rightsizing-series';
import { ROLES } from './role-labels';
import { SettingsSectionKey } from './sections';

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
 * Settings › Models: the playbook and the kinds on one account, then Intelligence against cost per task with
 * the picks of one rigor drawn on it, then every model the account runs. A model's detail is in the drawer.
 */
export function ModelsSection() {
  const now = useNow();
  const accounts = useAccounts();
  const [chosen, setChosen] = useState<AccountId | null>(null);
  const live = (accounts.data ?? []).filter((a) => !a.archived);
  // The page always has an account: the one chosen, else the default, else the first live one.
  const account =
    live.find((a) => a.id === chosen) ?? live.find((a) => a.isDefault) ?? live[0] ?? null;
  const accountId = account?.id ?? null;
  const models = useModels(accountId, accountId !== null);
  // The chart's rings follow one rigor; Standard is the one most work gets.
  const [rigor, setRigor] = useState<Rigor>(Rigor.Standard);
  const picks = useModelPicks(accountId, rigor, null);
  const offers = useModelOffers();
  const status = useCatalogueStatus();
  const refresh = useRefreshModels();
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

  const header = (
    <Stack gap={4}>
      <Group justify="space-between" align="center" wrap="nowrap">
        <Title order={3}>Models</Title>
        <Group gap="xs" wrap="nowrap">
          {refresh.isError ? (
            <Text size="xs" c="red" role="alert">
              {refresh.error.message}
            </Text>
          ) : null}
          <Select
            aria-label="Account"
            size="xs"
            w={240}
            leftSection={
              <Text size="xs" c="dimmed">
                Account
              </Text>
            }
            leftSectionWidth={72}
            leftSectionPointerEvents="none"
            allowDeselect={false}
            data={live.map((a) => ({ value: a.id, label: a.label }))}
            value={accountId}
            placeholder={accounts.isPending ? 'Reading accounts…' : 'No account'}
            disabled={live.length === 0}
            onChange={(value) => {
              const next = live.find((a) => a.id === value);
              if (next) setChosen(next.id);
            }}
          />
          <Tooltip
            label="Fetch prices from models.dev and re-read every account's model list"
            position="left"
          >
            <ActionIcon
              variant="default"
              size="input-xs"
              aria-label="Refresh Models"
              loading={refresh.isPending}
              onClick={() => {
                refresh.mutate();
              }}
            >
              <IconRefresh size={16} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      <Text size="xs" c="dimmed">
        {status.data !== undefined
          ? catalogueLine(status.data, now)
          : status.isError
            ? 'The catalogue status could not be read.'
            : 'Reading the catalogue…'}{' '}
        <ArtificialAnalysisCredit />
      </Text>
      <ArtificialAnalysisStatusLine />
    </Stack>
  );

  if (accounts.isPending)
    return (
      <Stack>
        {header}
        <Text c="dimmed">Reading accounts…</Text>
      </Stack>
    );
  // A failed background read keeps the accounts already shown, as during a daemon restart.
  if (accounts.isError && accounts.data === undefined)
    return (
      <Stack>
        {header}
        <Group gap="sm">
          <Text c="red" role="alert">
            {accounts.error.message}
          </Text>
          <Button
            variant="default"
            size="xs"
            onClick={() => {
              void accounts.refetch();
            }}
          >
            Try Again
          </Button>
        </Group>
      </Stack>
    );
  if (account === null)
    return (
      <Stack>
        {header}
        <Text c="dimmed">
          <Anchor
            renderRoot={(props) => (
              <Link
                {...props}
                to="/settings/$section"
                params={{ section: SettingsSectionKey.Accounts }}
              />
            )}
          >
            Add an account
          </Anchor>{' '}
          to see what each role gets.
        </Text>
      </Stack>
    );
  if (models.isError)
    return (
      <Stack>
        {header}
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
        {header}
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
  const drawnPicks = settling ? [] : (picks.data?.picks ?? []);
  const result = rightsizingSeries({ rows: accountRows, picks: drawnPicks, role: null, dots });
  const usedBy = new Map<string, string[]>();
  for (const pick of drawnPicks)
    if (pick.model !== null)
      usedBy.set(pick.model, [...(usedBy.get(pick.model) ?? []), roleLabel(pick.role)]);
  const note = costNote(account, offers.data ?? []);
  return (
    <Stack gap="lg">
      {header}
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
        <RaisedPanel>
          <PlaybookTable projectId={null} accountId={accountId} />
        </RaisedPanel>
      </Stack>
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
        onClose={() => {
          setOpened(false);
        }}
      />
    </Stack>
  );
}
