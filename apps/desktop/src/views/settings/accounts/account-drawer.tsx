import {
  accountDisplayName,
  AccountKind,
  needsSecret,
  type AccountDto,
  type AccountId,
} from '@10db/contracts';
import { Drawer, Stack, Text, Title } from '@mantine/core';
import { useAccounts } from '../../../daemon/account-queries';
import { IdentityCheck } from './identity-check';
import { SecretForm } from './secret-form';
import { SignInSteps } from './sign-in-steps';
import { UsageByProject } from './usage-by-project';

function AccountDrawerBody({ account }: { readonly account: AccountDto }) {
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
    </Stack>
  );
}

/**
 * One account's identity, sign-in and usage. The drawer stays mounted so Mantine returns focus to the
 * opener and plays the exit transition; `accountId` keeps the last account while it closes. The body
 * is keyed by account so a check made for another account never carries over.
 */
export function AccountDrawer({
  accountId,
  opened,
  onClose,
  onClosed,
}: {
  readonly accountId: AccountId | null;
  readonly opened: boolean;
  readonly onClose: () => void;
  /** Called once the exit transition has finished, after Mantine has returned focus. */
  readonly onClosed?: () => void;
}) {
  const accounts = useAccounts();
  const account = accounts.data?.find((a) => a.id === accountId);
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      {...(onClosed ? { onExitTransitionEnd: onClosed } : {})}
      position="right"
      size="md"
      title={account ? accountDisplayName(account) : 'Account'}
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      {account ? (
        <AccountDrawerBody key={account.id} account={account} />
      ) : (
        <Text c="dimmed">This account is no longer listed.</Text>
      )}
    </Drawer>
  );
}
