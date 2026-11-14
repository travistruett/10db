import type { AccountId } from '@10db/contracts';
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
import { useJudgeStatus } from '../../daemon/judge-queries';
import { useCatalogueStatus, useRefreshModels } from '../../daemon/model-queries';
import { useNow } from '../../shell/relative';
import { AgentsView } from './agents-view';
import { ArtificialAnalysisCredit } from './artificial-analysis-credit';
import { ArtificialAnalysisStatusLine } from './artificial-analysis-status-line';
import { DecisionsModelsView } from './decisions-models-view';
import { catalogueLine } from './model-format';
import { OpenRouterStatusLine } from './openrouter-status-line';
import { SettingsSectionKey } from './sections';

/** The two views of the page: the agents' models by account, and the models behind 10db's own decisions. */
const ModelsView = { Agents: 'agents', Decisions: 'decisions' } as const;
type ModelsView = (typeof ModelsView)[keyof typeof ModelsView];

const VIEW_LABELS = [
  { value: ModelsView.Agents, label: 'Agents' },
  { value: ModelsView.Decisions, label: 'Decisions' },
] as const;

const isModelsView = (value: string): value is ModelsView =>
  Object.values(ModelsView).some((view) => view === value);

const ACCOUNT_LABEL = (
  <Text size="xs" c="dimmed">
    Account
  </Text>
);

/** The account decisions are paid by, shown where the Agents view has its account; it is changed in Settings › Decisions. */
function PaidByAccount() {
  const judge = useJudgeStatus();
  const paidBy = judge.data?.account ?? null;
  const placeholder = judge.isPending
    ? 'Reading…'
    : judge.isError
      ? judge.error.message
      : 'No OpenRouter account';
  return (
    // WebKit shows no tooltip on a disabled control, so the hint sits on a wrapper around it.
    <Tooltip label="Change it under Settings › Decisions" position="bottom">
      <span>
        <Select
          aria-label="Account"
          size="xs"
          w={240}
          leftSection={
            <Text size="xs" c="dimmed">
              Paid by
            </Text>
          }
          leftSectionWidth={72}
          leftSectionPointerEvents="none"
          data={paidBy === null ? [] : [{ value: paidBy.id, label: paidBy.label }]}
          value={paidBy?.id ?? null}
          placeholder={placeholder}
          disabled
        />
      </span>
    </Tooltip>
  );
}

/**
 * Settings › Models: a title, a switch between the Agents and Decisions views and the account the page reads,
 * above the view chosen. The Agents account stays chosen across a switch; Decisions shows the account decisions
 * are paid by, which is changed in Settings › Decisions. A failure of the Agents view hides only that view.
 */
export function ModelsSection() {
  const now = useNow();
  const accounts = useAccounts();
  const [view, setView] = useState<ModelsView>(ModelsView.Agents);
  const [chosen, setChosen] = useState<AccountId | null>(null);
  const live = (accounts.data ?? []).filter((a) => !a.archived);
  // The Agents view always has an account: the one chosen, else the default, else the first live one.
  const account =
    live.find((a) => a.id === chosen) ?? live.find((a) => a.isDefault) ?? live[0] ?? null;
  const status = useCatalogueStatus();
  const refresh = useRefreshModels();
  const agents = view === ModelsView.Agents;

  const accountSelect = agents ? (
    <Select
      aria-label="Account"
      size="xs"
      w={240}
      leftSection={ACCOUNT_LABEL}
      leftSectionWidth={72}
      leftSectionPointerEvents="none"
      allowDeselect={false}
      data={live.map((a) => ({ value: a.id, label: a.label }))}
      value={account?.id ?? null}
      placeholder={accounts.isPending ? 'Reading accounts…' : 'No account'}
      disabled={live.length === 0}
      onChange={(value) => {
        const next = live.find((a) => a.id === value);
        if (next) setChosen(next.id);
      }}
    />
  ) : (
    <PaidByAccount />
  );

  const header = (
    <Stack gap={4}>
      <Group justify="space-between" align="center" wrap="nowrap">
        <Title order={3}>Models</Title>
        <Group gap="xs" wrap="nowrap">
          {agents && refresh.isError ? (
            <Text size="xs" c="red" role="alert">
              {refresh.error.message}
            </Text>
          ) : null}
          {accountSelect}
          {agents ? (
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
          ) : null}
        </Group>
      </Group>
      <SegmentedControl
        size="xs"
        w="fit-content"
        aria-label="Models view"
        data={[...VIEW_LABELS]}
        value={view}
        onChange={(value) => {
          if (isModelsView(value)) setView(value);
        }}
      />
      {agents ? (
        <>
          <Text size="xs" c="dimmed">
            {status.data !== undefined
              ? catalogueLine(status.data, now)
              : status.isError
                ? 'The catalogue status could not be read.'
                : 'Reading the catalogue…'}{' '}
            <ArtificialAnalysisCredit />
          </Text>
          <ArtificialAnalysisStatusLine />
          <OpenRouterStatusLine />
        </>
      ) : null}
    </Stack>
  );

  const body = () => {
    if (!agents) return <DecisionsModelsView />;
    if (accounts.isPending) return <Text c="dimmed">Reading accounts…</Text>;
    // A failed background read keeps the accounts already shown, as during a daemon restart.
    if (accounts.isError && accounts.data === undefined)
      return (
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
      );
    if (account === null)
      return (
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
      );
    return <AgentsView account={account} />;
  };

  return (
    <Stack gap="lg">
      {header}
      {body()}
    </Stack>
  );
}
