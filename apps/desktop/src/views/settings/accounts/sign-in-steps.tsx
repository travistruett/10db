import { AccountKind, type AccountDto } from '@10db/contracts';
import {
  ActionIcon,
  Button,
  Code,
  Collapse,
  CopyButton,
  Group,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useAccountSignIn } from '../../../daemon/account-queries';
import { ConnectAccount } from './connect-account';

/** The Terminal steps: sign in with the unmodified `claude` or `codex`, then check. */
function TerminalSteps({ account }: { readonly account: AccountDto }) {
  const signIn = useAccountSignIn(account.id, true);
  const isCodex = account.kind === AccountKind.CodexSignin;
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
        <Group gap="xs" wrap="nowrap" align="center">
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
      {isCodex ? (
        <Text size="sm">
          Sign-in asks which workspace to use. Pick the one whose plan should pay for this
          account&apos;s work.
        </Text>
      ) : null}
      <Text size="sm">3. Check sign-in</Text>
    </Stack>
  );
}

/**
 * How to sign a subscription in: Connect, with the Terminal steps behind a fallback. The check itself is
 * `IdentityCheck`.
 */
export function SignInSteps({
  account,
  onConnected,
}: {
  readonly account: AccountDto;
  /** The account's browser sign-in finished. */
  readonly onConnected: () => void;
}) {
  const [terminal, { toggle }] = useDisclosure(false);
  return (
    <Stack gap="xs">
      <ConnectAccount account={account} onConnected={onConnected} />
      <Button
        variant="subtle"
        size="compact-sm"
        style={{ alignSelf: 'flex-start' }}
        aria-expanded={terminal}
        onClick={toggle}
      >
        Sign in from Terminal instead
      </Button>
      <Collapse expanded={terminal}>
        {terminal ? <TerminalSteps account={account} /> : null}
      </Collapse>
    </Stack>
  );
}
