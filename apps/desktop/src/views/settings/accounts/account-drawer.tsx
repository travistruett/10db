import { accountDisplayName, AccountKind, type AccountId } from '@10db/contracts';
import { Drawer, Stack, Text, Title } from '@mantine/core';
import { useAccounts } from '../../../daemon/account-queries';
import { IdentityCheck } from './identity-check';
import { SignInSteps } from './sign-in-steps';
import { UsageByProject } from './usage-by-project';

/**
 * One account's identity, sign-in and usage. Render it with `key={accountId}` so a check made for
 * another account never carries over.
 */
export function AccountDrawer({
  accountId,
  onClose,
}: {
  readonly accountId: AccountId;
  readonly onClose: () => void;
}) {
  const accounts = useAccounts();
  const account = accounts.data?.find((a) => a.id === accountId);
  return (
    <Drawer
      opened
      onClose={onClose}
      position="right"
      size="md"
      title={account ? accountDisplayName(account) : 'Account'}
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      {account ? (
        <Stack gap="lg">
          <Stack gap="xs">
            <Title order={4}>Identity</Title>
            {account.kind === AccountKind.ClaudeSubscription ? (
              <SignInSteps account={account} />
            ) : null}
            <IdentityCheck account={account} />
          </Stack>
          <Stack gap="xs">
            <Title order={4}>Usage this month</Title>
            <UsageByProject accountId={account.id} />
          </Stack>
        </Stack>
      ) : (
        <Text c="dimmed">This account is no longer listed.</Text>
      )}
    </Drawer>
  );
}
