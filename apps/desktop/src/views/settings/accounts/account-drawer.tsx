import {
  accountDisplayName,
  needsSecret,
  harnessOf,
  signsInWithLogin,
  type AccountDto,
  type AccountId,
} from '@10db/contracts';
import { Badge, Drawer, Group, Stack, Text, Title } from '@mantine/core';
import { useCallback, useState } from 'react';
import { useAccounts } from '../../../daemon/account-queries';
import { useJudgeStatus } from '../../../daemon/judge-queries';
import { useProjects } from '../../../daemon/queries';
import { ACCOUNT_KIND_LABEL } from '../account-kind-label';
import { AccountPause } from './account-pause';
import { ArchiveAccount } from './archive-account';
import { EditAccountForm } from './edit-account-form';
import { IdentityCheck } from './identity-check';
import { SecretForm } from './secret-form';
import { SignInSteps } from './sign-in-steps';
import { TestAccount } from './test-account';
import { accountUsedBy, harnessLine, usedByText } from './used-by';
import { UsageByProject } from './usage-by-project';

/** A badge is never cut to its first letters, as the Factory's state badges aren't. */
const WHOLE_BADGE = {
  style: { minWidth: 'max-content' },
  styles: { label: { overflow: 'visible', textOverflow: 'clip' } },
} as const;

function noop() {
  // No caller needs to know.
}

/** What the first section is about: a login, a stored secret, or the identity a profile runs as. */
function sectionTitle(account: AccountDto): string {
  if (signsInWithLogin(account.kind)) return 'Sign-In';
  return needsSecret(account.kind, account.settings) ? 'Secret' : 'Identity';
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
  // Each finished browser sign-in asks the identity check to run once.
  const [checkRequests, setCheckRequests] = useState(0);
  const onConnected = useCallback(() => {
    setCheckRequests((n) => n + 1);
  }, []);
  const projects = useProjects();
  const judge = useJudgeStatus();
  const agents = harnessOf(account) !== null;
  return (
    <Stack gap="lg">
      <Stack gap={2}>
        <Text size="xs" c="dimmed">
          {usedByText(accountUsedBy(account, projects.data ?? [], judge.data))}
        </Text>
        {agents ? null : (
          <Text size="xs" c="dimmed">
            {harnessLine(account)}
          </Text>
        )}
      </Stack>
      {account.archived || !agents ? null : <AccountPause account={account} />}
      <Stack gap="xs">
        <Title order={4}>{sectionTitle(account)}</Title>
        {signsInWithLogin(account.kind) && !account.archived ? (
          <SignInSteps account={account} onConnected={onConnected} />
        ) : null}
        {needsSecret(account.kind, account.settings) ? <SecretForm account={account} /> : null}
        {agents ? (
          <IdentityCheck account={account} checkRequests={checkRequests} />
        ) : account.archived ? null : (
          <TestAccount account={account} />
        )}
      </Stack>
      <Stack gap="xs">
        <Title order={4}>Usage This Month</Title>
        <UsageByProject account={account} />
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
      title={
        account ? (
          <Group component="span" gap="xs" wrap="nowrap">
            {/* The drawer is named by its title: the label and the identity, as the accounts table says it.
                The badges repeat the kind and Default for the eye, so they stay out of the name. */}
            <span>{accountDisplayName(account)}</span>
            <Badge size="sm" variant="light" color="gray" aria-hidden {...WHOLE_BADGE}>
              {ACCOUNT_KIND_LABEL[account.kind]}
            </Badge>
            {account.isDefault ? (
              <Badge size="sm" variant="light" color="gray" aria-hidden {...WHOLE_BADGE}>
                Default
              </Badge>
            ) : null}
          </Group>
        ) : (
          'Account'
        )
      }
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
