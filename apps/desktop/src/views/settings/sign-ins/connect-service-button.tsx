import {
  CONNECTABLE_SERVICE_LABELS,
  ConnectNext,
  McpSignInState,
  type ConnectableService,
  type ProjectId,
  type YourMcpServerKey,
  type AccountId,
} from '@10db/contracts';
import { Button, CopyButton, Group, Stack, Text } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { useConnectService } from '../../../daemon/sign-in-queries';
import { useMcpSignIns, useStartMcpSignIn } from '../../../daemon/trust-queries';

/**
 * One click that sets a service up for a project's account (the daemon adds its server, approves it and starts
 * the sign-in), then says what is left: a browser sign-in under way with a way to open it again, or, for a
 * Claude Code account, `/mcp` to run there. A failure shows the daemon's words with Try Again.
 */
export function ConnectServiceButton({
  service,
  projectId,
  accountId,
  serverKey,
  signedIn,
  onConnected,
  onStarted,
  onFinished,
}: {
  readonly service: ConnectableService;
  readonly projectId: ProjectId;
  readonly accountId: AccountId;
  /** The account's server for the service once the daemon has one; its sign-in is read from Trust's rows. */
  readonly serverKey: YourMcpServerKey | null;
  /** Whether the account's sign-in to the service is done, when known. */
  readonly signedIn: boolean | null;
  /** The service works for the account, or only Claude Code's `/mcp` is left: the caller's own follow-on step. */
  readonly onConnected?: () => void;
  /** Connect was pressed: the caller keeps this component on screen until it finishes. */
  readonly onStarted: () => void;
  /** Nothing is left to show: the caller may show its usual control. */
  readonly onFinished: () => void;
}) {
  const label = CONNECTABLE_SERVICE_LABELS[service];
  const connect = useConnectService(service);
  const signIns = useMcpSignIns();
  const reopen = useStartMcpSignIn();
  const next = connect.data?.next;
  const connected = useRef(false);
  const row = signIns.data?.rows.find((r) => r.accountId === accountId && r.key === serverKey);

  // Each follow-on runs once: when the service works, or at once for a Claude Code account.
  const done =
    next === ConnectNext.SignedIn ||
    next === ConnectNext.ClaudeCode ||
    (next === ConnectNext.SigningIn && signedIn === true);
  useEffect(() => {
    if (!done || connected.current) return;
    connected.current = true;
    onConnected?.();
    if (next !== ConnectNext.ClaudeCode) onFinished();
  }, [done, next, onConnected, onFinished]);

  const press = (): void => {
    connected.current = false;
    onStarted();
    connect.mutate(projectId);
  };

  if (next === ConnectNext.ClaudeCode)
    return (
      <Stack gap={4} align="flex-end">
        <Text size="sm">Finish in Claude Code: run /mcp and sign in to {label}.</Text>
        <Group gap="xs">
          <CopyButton value="/mcp">
            {({ copied, copy }) => (
              <Button size="compact-xs" variant="default" onClick={copy}>
                {copied ? 'Copied' : 'Copy /mcp'}
              </Button>
            )}
          </CopyButton>
          <Button size="compact-xs" variant="subtle" onClick={onFinished}>
            Done
          </Button>
        </Group>
      </Stack>
    );
  if (next === ConnectNext.SigningIn && !done)
    return (
      <Stack gap={4} align="flex-end">
        {row?.state === McpSignInState.Failed ? (
          <Text size="xs" c="red">
            {row.message ?? `Signing in to ${label} failed.`}
          </Text>
        ) : (
          <Text size="sm" c="dimmed">
            Signing In in Your Browser…
          </Text>
        )}
        <Button
          size="compact-xs"
          variant="default"
          loading={reopen.isPending || connect.isPending}
          onClick={() => {
            if (row?.state === McpSignInState.Failed) press();
            else if (row) reopen.mutate({ accountId, key: row.key });
          }}
        >
          {row?.state === McpSignInState.Failed ? 'Try Again' : 'Open Page Again'}
        </Button>
        {reopen.isError ? (
          <Text size="xs" c="red">
            {reopen.error.message}
          </Text>
        ) : null}
      </Stack>
    );
  return (
    <Stack gap={4} align="flex-end">
      {connect.isError ? (
        <Text size="xs" c="red" ta="right" maw={420}>
          {connect.error.message}
        </Text>
      ) : null}
      <Button size="compact-sm" loading={connect.isPending} onClick={press}>
        {connect.isError ? 'Try Again' : `Connect ${label}`}
      </Button>
    </Stack>
  );
}
