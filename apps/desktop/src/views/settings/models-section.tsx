import type { AccountId } from '@10db/contracts';
import { ActionIcon, Anchor, Button, Group, Select, Stack, Text, Tooltip } from '@mantine/core';
import { TitleRow } from '../../shell/title-row';
import { Link } from '@tanstack/react-router';
import { IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import { useRefreshModels } from '../../daemon/model-queries';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { AgentsView } from './agents-view';
import { DataSources, DataSourcesWarning } from './data-sources';
import { SettingsSectionKey } from './sections';

const ACCOUNT_LABEL = (
  <Text size="xs" c="dimmed">
    Account
  </Text>
);

/**
 * Settings › Models: a title, the account the page reads, a refresh and the data sources, above the agents'
 * models. A failure of the Agents view hides only that view.
 */
export function ModelsSection() {
  const accounts = useAccounts();
  const [chosen, setChosen] = useState<AccountId | null>(null);
  const live = (accounts.data ?? []).filter((a) => !a.archived);
  // The page always has an account: the one chosen, else the default, else the first live one.
  const account =
    live.find((a) => a.id === chosen) ?? live.find((a) => a.isDefault) ?? live[0] ?? null;
  const refresh = useRefreshModels();

  const header = (
    <>
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
    </>
  );

  const body = () => {
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
            Add an Account
          </Anchor>{' '}
          to see what each role gets.
        </Text>
      );
    return <AgentsView account={account} />;
  };

  return (
    <Stack gap="xl">
      {header}
      <DataSourcesWarning />
      {body()}
    </Stack>
  );
}
