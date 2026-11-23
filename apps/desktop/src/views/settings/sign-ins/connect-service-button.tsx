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
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useConnectService } from '../../../daemon/sign-in-queries';
import { SettingsSectionKey } from '../sections';
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
  /** The builder says a sign-in done in Claude Code worked: the caller's own follow-on step. A Codex account's is the daemon's. */
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
  const finished = useRef(false);
  const navigate = useNavigate();
  const row = signIns.data?.rows.find((r) => r.accountId === accountId && r.key === serverKey);

  // A Codex account is done once its sign-in is; the daemon has run the service's follow-on by then.
  const done =
    next === ConnectNext.SignedIn || (next === ConnectNext.SigningIn && signedIn === true);
  useEffect(() => {
    if (!done || finished.current) return;
    finished.current = true;
    onFinished();
  }, [done, onFinished]);

  const press = (): void => {
    finished.current = false;
    onStarted();
    connect.mutate(projectId);
  };

  if (next === ConnectNext.ClaudeCode) {
    // A Claude plan account in its own folder signs in from a terminal, as Trust's servers list says.
    const terminal = signIns.data?.terminal.find((t) => t.accountId === accountId);
    const command = terminal?.command ?? '/mcp';
    return (
      <Stack gap={4} align="flex-end">
        <Text size="sm">
          {terminal === undefined
            ? `Finish in Claude Code: run /mcp and sign in to ${label}.`
            : `Finish in your terminal: run the command, then /mcp and sign in to ${label}.`}
        </Text>
        <Group gap="xs">
          <CopyButton value={command}>
            {({ copied, copy }) => (
              <Button size="compact-xs" variant="default" onClick={copy}>
                {copied ? 'Copied' : terminal === undefined ? 'Copy /mcp' : 'Copy Command'}
              </Button>
            )}
          </CopyButton>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => {
              onConnected?.();
              onFinished();
            }}
          >
            Done
          </Button>
        </Group>
      </Stack>
    );
  }
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
        {row === undefined ? null : (
          <Button
            size="compact-xs"
            variant="default"
            loading={reopen.isPending || connect.isPending}
            onClick={() => {
              if (row.state === McpSignInState.Failed) press();
              else reopen.mutate({ accountId, key: row.key });
            }}
          >
            {row.state === McpSignInState.Failed ? 'Try Again' : 'Open Page Again'}
          </Button>
        )}
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
      <Group gap="xs">
        {connect.isError && connect.error.message.includes('Settings › Trust') ? (
          <Button
            size="compact-sm"
            variant="default"
            onClick={() => {
              void navigate({
                to: '/settings/$section',
                params: { section: SettingsSectionKey.Trust },
              });
            }}
          >
            Open Trust
          </Button>
        ) : null}
        <Button size="compact-sm" loading={connect.isPending} onClick={press}>
          {connect.isError ? 'Try Again' : `Connect ${label}`}
        </Button>
      </Group>
    </Stack>
  );
}
