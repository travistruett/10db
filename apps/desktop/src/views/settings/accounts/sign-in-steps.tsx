import type { AccountDto } from '@10db/contracts';
import { ActionIcon, Code, CopyButton, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useAccountSignIn } from '../../../daemon/account-queries';

/** How to sign a subscription in with the unmodified `claude`; the check itself is `IdentityCheck`. */
export function SignInSteps({ account }: { readonly account: AccountDto }) {
  const signIn = useAccountSignIn(account.id, true);
  return (
    <Stack gap="xs">
      {account.isDefault ? (
        <Text size="sm" c="dimmed">
          This is the login 10db already uses. The command below switches it to another login.
        </Text>
      ) : null}
      <Text size="sm">1. In Terminal, run</Text>
      {signIn.isPending ? (
        <Text size="sm" c="dimmed">
          Loading the command…
        </Text>
      ) : signIn.isError ? (
        <Text size="sm" c="red">
          {signIn.error.message}
        </Text>
      ) : (
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Code block style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {signIn.data.command}
          </Code>
          <CopyButton value={signIn.data.command}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy command'} withArrow>
                <ActionIcon
                  size="md"
                  variant="subtle"
                  color={copied ? 'green' : 'gray'}
                  aria-label={copied ? 'Copied' : 'Copy command'}
                  onClick={copy}
                >
                  {copied ? (
                    <IconCheck size={20} stroke={1.5} />
                  ) : (
                    <IconCopy size={20} stroke={1.5} />
                  )}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
      )}
      <Text size="sm">2. Sign in as the email this account should use</Text>
      <Text size="sm">3. Check sign-in</Text>
    </Stack>
  );
}
