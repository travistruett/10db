import {
  ActionIcon,
  Button,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { TitleRow } from '../../shell/title-row';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { IconCpu, IconPlus, IconRefresh } from '@tabler/icons-react';
import { EmptyState } from '../../shell/empty-state';
import { useJudgeStatus } from '../../daemon/judge-queries';
import { useRefreshModels } from '../../daemon/model-queries';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { AgentModelsView } from './agent-models-view';
import { DataSources, DataSourcesWarning } from './data-sources';
import { DecisionModelsView } from './decision-models-view';
import { ModelClass, settingsSearch } from './focus-target';
import { SettingsSectionKey } from './sections';
import { useViewedAccount, ViewedAccountSelect } from './viewed-account';

const CLASS_OPTIONS = [
  { value: ModelClass.Agent, label: 'Agent Models' },
  { value: ModelClass.Decision, label: 'Decision Models' },
];

const isModelClass = (value: string): value is ModelClass =>
  value === ModelClass.Agent || value === ModelClass.Decision;

/** Paid by <account> with a link to where it is picked: what bills the decision models. */
function DecisionBilling() {
  const status = useJudgeStatus();
  const account = status.data?.account ?? null;
  return (
    <Group gap="xs" wrap="nowrap">
      <Text size="sm" c="dimmed">
        {account === null ? 'No account pays yet' : `Paid by ${account.label}`}
      </Text>
      <Button
        size="xs"
        variant="default"
        renderRoot={(props) => (
          <Link
            {...props}
            to="/settings/$section"
            params={{ section: SettingsSectionKey.Decisions }}
            search={{ focus: 'paid-by' }}
          />
        )}
      >
        {account === null ? 'Choose' : 'Change'}
      </Button>
    </Group>
  );
}

/**
 * Settings › Models: what the Playbook and the decisions choose from. A title with the data sources and a
 * refresh, then Agent Models or Decision Models as the address says, each with the account that bills it.
 * A failure of one class hides only that class.
 */
export function ModelsSection() {
  const viewed = useViewedAccount();
  const { accounts, account } = viewed;
  const navigate = useNavigate();
  const modelClass = settingsSearch(useSearch({ strict: false })).class ?? ModelClass.Agent;
  const refresh = useRefreshModels();

  const header = (
    <TitleRow
      title="Models"
      actions={
        <>
          {refresh.isError ? (
            <Text size="xs" c="red" role="alert">
              {refresh.error.message}
            </Text>
          ) : null}
          <DataSources />
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
        </>
      }
    />
  );

  const agentBody = () => {
    if (accounts.isPending)
      return <PageLoading shape={PageLoadingShape.List} label="Reading accounts" />;
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
        <EmptyState
          icon={IconCpu}
          title="No account to read models from"
          action={{
            label: 'Add an Account',
            icon: IconPlus,
            onClick: () => {
              void navigate({
                to: '/settings/$section',
                params: { section: SettingsSectionKey.Accounts },
              });
            },
          }}
        >
          Add a Claude or Codex account, and the models it can run show here with what each role
          gets.
        </EmptyState>
      );
    return <AgentModelsView account={account} />;
  };

  const classLine = (
    <Group justify="space-between" align="center" wrap="nowrap">
      <Text size="sm" c="dimmed">
        {modelClass === ModelClass.Agent
          ? 'Run your Plan, Build and Review sessions.'
          : 'Make 10db’s quick yes/no calls.'}
      </Text>
      {modelClass === ModelClass.Agent ? (
        <ViewedAccountSelect viewed={viewed} />
      ) : (
        <DecisionBilling />
      )}
    </Group>
  );

  return (
    <Stack gap="xl">
      {header}
      <DataSourcesWarning />
      {/* The class switch heads the page in a band of its own, so the page below plainly belongs to it. */}
      <Paper radius="md" p="md" bg="var(--mantine-color-body)" withBorder>
        <Stack gap="sm">
          <SegmentedControl
            aria-label="Kind of model"
            w="fit-content"
            data={CLASS_OPTIONS}
            value={modelClass}
            onChange={(value) => {
              if (isModelClass(value))
                void navigate({
                  to: '/settings/$section',
                  params: { section: SettingsSectionKey.Models },
                  search: (previous) => ({ ...previous, class: value }),
                  replace: true,
                });
            }}
          />
          {classLine}
        </Stack>
      </Paper>
      {modelClass === ModelClass.Agent ? agentBody() : <DecisionModelsView />}
    </Stack>
  );
}
