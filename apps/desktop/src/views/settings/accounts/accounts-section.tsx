import { AccountKind, runsAgents, type AccountDto, type AccountId } from '@10db/contracts';
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Group,
  Progress,
  Skeleton,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useSearch } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useAccounts, useAccountUsage } from '../../../daemon/account-queries';
import { useJudgeStatus } from '../../../daemon/judge-queries';
import { useProjects } from '../../../daemon/queries';
import { CountBadge } from '../../../shell/count-badge';
import { ACCOUNT_KIND_LABEL } from '../account-kind-label';
import { AccountDrawer } from './account-drawer';
import { AccountPause } from './account-pause';
import { AddAccountModal } from './add-account-modal';
import { settingsSearch } from '../focus-target';
import { MARK_OF_KIND, RowMarkIcon } from '../row-mark';
import { ACCOUNT_STATUS_LABEL, AccountStatus, accountStatus } from './account-status';
import { capShare, formatTokens, formatUsd } from './usage-text';
import { CANT_RUN_AGENTS, accountUsedBy, usedByText } from './used-by';

/** Waiting on a human is yellow; green, the done colour, marks an account that can run. */
const STATUS_COLOR: Readonly<Record<AccountStatus, string>> = {
  [AccountStatus.Ready]: 'green',
  [AccountStatus.NeedsSignIn]: 'yellow',
  [AccountStatus.NeedsSecret]: 'yellow',
  [AccountStatus.Archived]: 'gray',
};

function UsageCell({ account }: { readonly account: AccountDto }) {
  const usage = useAccountUsage(account.id);
  if (usage.isPending) return <Skeleton h={20} w={96} aria-label="Loading usage" />;
  if (usage.isError)
    return (
      <Text size="sm" c="dimmed">
        Usage unavailable
      </Text>
    );
  const { total, monthlyCapUsd } = usage.data;
  // An OpenRouter account runs no session: its month is its decisions' dollars, or a dash when none are its own.
  if (account.kind === AccountKind.OpenRouter)
    return <Text size="sm">{total.costUsd === null ? '—' : formatUsd(total.costUsd)}</Text>;
  if (total.costUsd === null)
    return <Text size="sm">{formatTokens(total.tokensIn + total.tokensOut)} tokens</Text>;
  const share = capShare(usage.data);
  if (monthlyCapUsd === null || share === null)
    return <Text size="sm">{formatUsd(total.costUsd)}</Text>;
  return (
    <Stack gap={4}>
      <Text size="sm">
        {formatUsd(total.costUsd)} of {formatUsd(monthlyCapUsd)}
      </Text>
      <Progress
        size="sm"
        value={Math.min(share.pct, 100)}
        color={share.reached ? 'orange' : 'blue'}
        aria-label={`${account.label} spend against its cap`}
      />
    </Stack>
  );
}

function AccountRow({
  account,
  usedBy,
  onOpen,
}: {
  readonly account: AccountDto;
  readonly usedBy: readonly string[];
  readonly onOpen: (account: AccountDto) => void;
}) {
  const status = accountStatus(account);
  return (
    <Table.Tr>
      <Table.Td>
        <Stack gap={4}>
          <Group gap="xs" wrap="nowrap">
            <RowMarkIcon mark={MARK_OF_KIND[account.kind]} />
            <UnstyledButton
              aria-label={`Open ${account.label}`}
              onClick={() => {
                onOpen(account);
              }}
            >
              <Text size="sm" fw={500}>
                {account.label}
              </Text>
            </UnstyledButton>
            {account.isDefault ? (
              <Badge size="sm" variant="light" color="gray">
                Default
              </Badge>
            ) : null}
          </Group>
          {runsAgents(account.kind) ? (
            <Text size="xs" c="dimmed">
              {account.expectedIdentity ?? 'No identity yet'}
            </Text>
          ) : null}
          <Text size="xs" c="dimmed">
            {usedByText(usedBy)}
            {runsAgents(account.kind) ? '' : ` · ${CANT_RUN_AGENTS}`}
          </Text>
          {account.archived || !runsAgents(account.kind) ? null : (
            <AccountPause account={account} />
          )}
        </Stack>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{ACCOUNT_KIND_LABEL[account.kind]}</Text>
      </Table.Td>
      <Table.Td>
        <Badge size="sm" variant="light" color={STATUS_COLOR[status]}>
          {ACCOUNT_STATUS_LABEL[status]}
        </Badge>
      </Table.Td>
      <Table.Td ta="right">
        <UsageCell account={account} />
      </Table.Td>
    </Table.Tr>
  );
}

function ArchivedList({ accounts }: { readonly accounts: readonly AccountDto[] }) {
  return (
    <Accordion variant="contained">
      <Accordion.Item value="archived">
        <Accordion.Control>
          <Group gap="xs">
            Archived
            <CountBadge count={accounts.length} />
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap="xs">
            {accounts.map((a) => (
              <Group key={a.id} justify="space-between">
                <Text size="sm">{a.label}</Text>
                <Text size="sm" c="dimmed">
                  {ACCOUNT_KIND_LABEL[a.kind]}
                </Text>
              </Group>
            ))}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

/** The app-wide accounts: identity, kind, status and this month's usage. */
export function AccountsSection() {
  const [selected, setSelected] = useState<AccountId | null>(null);
  const [opened, setOpened] = useState(false);
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  // The Create button that opened a new account's drawer is gone by the time the drawer closes, so
  // Mantine has nothing to return focus to.
  const returnToAdd = useRef(false);
  const accounts = useAccounts();
  const projects = useProjects();
  const judge = useJudgeStatus();
  // `?focus=<account id>` opens that account's drawer, so a link from another page lands on it.
  const focus = settingsSearch(useSearch({ strict: false })).focus;
  const named = focus === undefined ? undefined : accounts.data?.find((a) => a.id === focus);
  // Closing the drawer the address opened must not open it again, so the closed account is remembered.
  const [dismissed, setDismissed] = useState<AccountId | null>(null);
  const focusOpen = named !== undefined && dismissed !== named.id;
  if (accounts.isPending) return <Text c="dimmed">Loading accounts…</Text>;
  // A failed background refetch also sets isError while the last list is still here; that must not
  // replace the table, the open drawer and an edit in progress.
  if (accounts.data === undefined)
    return <Text c="red">Accounts could not be loaded. Check that the daemon is running.</Text>;
  const live = accounts.data.filter((a) => !a.archived);
  const archived = accounts.data.filter((a) => a.archived);
  return (
    <Stack>
      {accounts.isError ? (
        <Alert color="red" role="alert">
          Accounts could not be loaded. Check that the daemon is running.
        </Alert>
      ) : null}
      <Group justify="flex-end">
        <Button
          ref={addButton}
          leftSection={<IconPlus size={16} stroke={1.5} />}
          onClick={() => {
            setAdding(true);
          }}
        >
          Add Account
        </Button>
      </Group>
      {/* The account column takes the spare width; the rest are fixed, and usage sits right like any number. */}
      <Table aria-label="Accounts" verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Account</Table.Th>
            <Table.Th w={220}>Kind</Table.Th>
            <Table.Th w={140}>Status</Table.Th>
            <Table.Th w={220} ta="right">
              This month
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {live.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              usedBy={accountUsedBy(a, projects.data ?? [], judge.data)}
              onOpen={(account) => {
                returnToAdd.current = false;
                setSelected(account.id);
                setOpened(true);
              }}
            />
          ))}
        </Table.Tbody>
      </Table>
      {archived.length > 0 ? <ArchivedList accounts={archived} /> : null}
      <AddAccountModal
        opened={adding}
        onClose={() => {
          setAdding(false);
        }}
        onCreated={(id) => {
          returnToAdd.current = true;
          setSelected(id);
          setOpened(true);
        }}
      />
      <AccountDrawer
        accountId={selected ?? (focusOpen ? named.id : null)}
        opened={opened || focusOpen}
        onClose={() => {
          setOpened(false);
          if (named !== undefined) setDismissed(named.id);
        }}
        onArchived={() => {
          // The row that opened the drawer moves to Archived, so Mantine has nothing to return focus to.
          returnToAdd.current = true;
        }}
        onClosed={() => {
          if (!returnToAdd.current) return;
          returnToAdd.current = false;
          addButton.current?.focus();
        }}
      />
    </Stack>
  );
}
