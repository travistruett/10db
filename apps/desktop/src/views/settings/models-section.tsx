import { ActionIcon, Button, Group, Stack, Text, Tooltip } from '@mantine/core';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { IconCpu, IconPlus, IconRefresh } from '@tabler/icons-react';
import { EmptyState } from '../../shell/empty-state';
import { useJudgeStatus } from '../../daemon/judge-queries';
import { useRefreshModels } from '../../daemon/model-queries';
import { PageTabs, type PageTab } from '../../shell/page-intro';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { AgentModelsView } from './agent-models-view';
import { DataSources, DataSourcesWarning } from './data-sources';
import { DecisionModelsView } from './decision-models-view';
import { ModelClass, settingsSearch } from './focus-target';
import { SettingsSectionKey } from './sections';
import { SettingsPageHeader } from './settings-page';
import { useViewedAccount, ViewedAccountSelect } from './viewed-account';
import { ControlSize } from '../../shell/control-size';

const CLASS_TABS: readonly PageTab<ModelClass>[] = [
  { value: ModelClass.Agent, label: 'Language Models' },
  { value: ModelClass.Decision, label: 'Decision Models' },
];

/** The account the decision models run on, with a link to where it is picked. */
function DecisionBilling() {
  const status = useJudgeStatus();
  const account = status.data?.account ?? null;
  // With no account paying, the empty state below carries the one action.
  if (account === null) return null;
  return (
    <Group gap="xs" wrap="nowrap">
      <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
        Account: {account.label}
      </Text>
      <Button
        size={ControlSize.Toolbar}
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
        Change
      </Button>
    </Group>
  );
}

/**
 * Settings › Models: what the Playbook and the decisions choose from. Its header's tabs are Language Models and
 * Decision Models, kept in the address; at their right sit the account that bills the open class, the data
 * sources and a refresh. A failure of one class hides only that class.
 */
export function ModelsSection() {
  const viewed = useViewedAccount();
  const { accounts, account } = viewed;
  const navigate = useNavigate();
  const modelClass = settingsSearch(useSearch({ strict: false })).class ?? ModelClass.Agent;
  const refresh = useRefreshModels();

  const header = (
    <SettingsPageHeader
      sectionKey={SettingsSectionKey.Models}
      tabs={
        <PageTabs
          label="Kind of model"
          tabs={CLASS_TABS}
          value={modelClass}
          onChange={(value) => {
            void navigate({
              to: '/settings/$section',
              params: { section: SettingsSectionKey.Models },
              search: (previous) => ({ ...previous, class: value }),
              replace: true,
            });
          }}
        />
      }
      actions={
        <>
          {modelClass === ModelClass.Agent ? (
            <ViewedAccountSelect viewed={viewed} width={200} />
          ) : (
            <DecisionBilling />
          )}
          <DataSources />
          <Tooltip
            label="Fetch prices from models.dev and re-read every account's model list"
            position="bottom-end"
          >
            <ActionIcon
              variant="default"
              size={ControlSize.Toolbar}
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

  return (
    <Stack gap="xl">
      {header}
      <DataSourcesWarning />
      {refresh.isError ? (
        <Text size="xs" c="red" role="alert">
          {refresh.error.message}
        </Text>
      ) : null}
      {modelClass === ModelClass.Agent ? agentBody() : <DecisionModelsView />}
    </Stack>
  );
}
