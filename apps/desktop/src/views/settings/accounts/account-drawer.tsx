import {
  accountDisplayName,
  AccountKind,
  needsSecret,
  type AccountDto,
  type AccountId,
} from '@10db/contracts';
import { Drawer, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { useAccounts } from '../../../daemon/account-queries';
import { ArchiveAccount } from './archive-account';
import { EditAccountForm } from './edit-account-form';
import { IdentityCheck } from './identity-check';
import { SecretForm } from './secret-form';
import { SignInSteps } from './sign-in-steps';
import { UsageByProject } from './usage-by-project';

function noop() {
  // No caller needs to know.
}

function AccountDrawerBody({
  account,
  onClose,
  onArchived,
  confirmingArchive,
  onConfirmingArchiveChange,
}: {
  readonly account: AccountDto;
  readonly confirmingArchive: boolean;
  readonly onConfirmingArchiveChange: (confirming: boolean) => void;
  readonly onClose: () => void;
  readonly onArchived: () => void;
}) {
  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Title order={4}>Identity</Title>
        {account.kind === AccountKind.ClaudeSubscription ? <SignInSteps account={account} /> : null}
        {needsSecret(account.kind, account.settings) ? <SecretForm account={account} /> : null}
        <IdentityCheck account={account} />
      </Stack>
      <Stack gap="xs">
        <Title order={4}>Usage this month</Title>
        <UsageByProject accountId={account.id} />
      </Stack>
      {account.archived ? null : (
        <>
          <Stack gap="xs">
            <Title order={4}>Settings</Title>
            <EditAccountForm account={account} />
          </Stack>
          <Stack gap="xs">
            <Title order={4}>Archive</Title>
            <ArchiveAccount
              account={account}
              confirming={confirmingArchive}
              onConfirmingChange={onConfirmingArchiveChange}
              onArchived={() => {
                onArchived();
                onClose();
              }}
            />
          </Stack>
        </>
      )}
    </Stack>
  );
}

/**
 * One account's identity, sign-in, usage, settings and archive. The drawer stays mounted so Mantine returns focus to the
 * opener and plays the exit transition; `accountId` keeps the last account while it closes. The body
 * is keyed by account so a check made for another account never carries over.
 */
export function AccountDrawer({
  accountId,
  opened,
  onClose,
  onClosed,
  onArchived,
}: {
  readonly accountId: AccountId | null;
  readonly opened: boolean;
  readonly onClose: () => void;
  /** Called once the exit transition has finished, after Mantine has returned focus. */
  readonly onClosed?: () => void;
  /** Called when the account has been archived, just before the drawer closes. */
  readonly onArchived?: () => void;
}) {
  const accounts = useAccounts();
  // Mantine's Modal and Drawer both listen for Escape on the window, so the drawer must sit it out
  // while the archive confirmation is open.
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const account = accounts.data?.find((a) => a.id === accountId);
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      closeOnEscape={!confirmingArchive}
      {...(onClosed ? { onExitTransitionEnd: onClosed } : {})}
      position="right"
      size="md"
      title={account ? accountDisplayName(account) : 'Account'}
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      {account ? (
        <AccountDrawerBody
          key={account.id}
          account={account}
          confirmingArchive={confirmingArchive}
          onConfirmingArchiveChange={setConfirmingArchive}
          onClose={onClose}
          onArchived={onArchived ?? noop}
        />
      ) : (
        <Text c="dimmed">This account is no longer listed.</Text>
      )}
    </Drawer>
  );
}
