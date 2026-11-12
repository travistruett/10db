import type { AccountDto, AccountId, ModelRowDto, StepRole } from '@10db/contracts';
import { SegmentedControl, Select, Stack, Text, Group } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useModelOffers, useModelPicks } from '../../daemon/model-queries';
import { ArtificialAnalysisCredit } from './artificial-analysis-credit';
import { costNote } from './model-format';
import { RightsizingChart } from './rightsizing-chart';
import { DotsMode, rightsizingSeries } from './rightsizing-series';
import { RolePicksPanel } from './role-picks-panel';

const DOTS_LABELS = [
  { value: DotsMode.Every, label: 'Every effort' },
  { value: DotsMode.Pareto, label: 'Pareto only' },
] as const;

const isDotsMode = (value: string): value is DotsMode =>
  Object.values(DotsMode).some((mode) => mode === value);

/**
 * Intelligence against cost per task for the models one account can run, with the router's pick for every role.
 * The rows are the table's, already limited to the account and the header filters; `settling` is true while
 * they are still another account's, so no ring is drawn on a price that is not this account's.
 */
export function ModelsChartView({
  rows,
  names,
  accounts,
  accountId,
  onAccount,
  accountsReady,
  settling,
}: {
  readonly rows: readonly ModelRowDto[];
  readonly names: ReadonlyMap<string, string>;
  /** The accounts the chart can price on: live ones only. */
  readonly accounts: readonly AccountDto[];
  readonly accountId: AccountId | null;
  readonly onAccount: (id: AccountId) => void;
  /** Whether the accounts have loaded, so an empty list means there are none. */
  readonly accountsReady: boolean;
  readonly settling: boolean;
}) {
  const offers = useModelOffers();
  const picks = useModelPicks(accountId);
  const [role, setRole] = useState<StepRole | null>(null);
  const [dots, setDots] = useState<DotsMode>(DotsMode.Every);

  // The chart prices on one account, so with none chosen (or the chosen one gone) it takes the default one, and the
  // table then shows that account too.
  const fallback = accounts.find((a) => a.isDefault) ?? accounts[0];
  const fallbackId = fallback?.id ?? null;
  useEffect(() => {
    if (accountId === null && fallbackId !== null) onAccount(fallbackId);
  }, [accountId, fallbackId, onAccount]);

  if (!accountsReady) return <Text c="dimmed">Reading accounts…</Text>;
  if (accounts.length === 0)
    return (
      <Stack gap="xs">
        <Text c="dimmed">Add an account to see what each role gets.</Text>
        <ArtificialAnalysisCredit />
      </Stack>
    );

  const drawnPicks = settling ? [] : (picks.data?.picks ?? []);
  const result = rightsizingSeries({ rows, picks: drawnPicks, role, dots });
  const costLabel = `Cost per task (USD, log scale). ${costNote(accounts.find((a) => a.id === accountId) ?? null, offers.data ?? [])}`;
  return (
    <Stack>
      <Group justify="space-between">
        <Select
          aria-label="Chart account"
          size="xs"
          w={240}
          allowDeselect={false}
          data={accounts.map((a) => ({ value: a.id, label: a.label }))}
          value={accountId}
          placeholder="Choose an account"
          onChange={(value) => {
            const chosen = accounts.find((a) => a.id === value);
            if (chosen) onAccount(chosen.id);
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
      <RightsizingChart result={result} costLabel={costLabel} />
      {result.omitted > 0 ? (
        <Text size="xs" c="dimmed">
          {result.omitted} {result.omitted === 1 ? 'effort has' : 'efforts have'} no Intelligence or
          cost per task yet, so {result.omitted === 1 ? 'it is' : 'they are'} not plotted.
        </Text>
      ) : null}
      <ArtificialAnalysisCredit />
      {picks.isError ? (
        <Text size="sm" c="red">
          What each role gets could not be loaded.
        </Text>
      ) : accountId === null ? (
        <Text size="sm" c="dimmed">
          Choose an account
        </Text>
      ) : picks.data === undefined ? (
        <Text size="sm" c="dimmed">
          Reading what each role gets…
        </Text>
      ) : (
        <RolePicksPanel
          picks={picks.data.picks}
          names={names}
          notOnChart={result.notOnChart}
          selected={role}
          onSelect={setRole}
        />
      )}
    </Stack>
  );
}
