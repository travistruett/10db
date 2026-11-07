import type { AccountDto } from '@10db/contracts';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  accountLoginKey,
  useAccountLoginEnd,
  useCancelConnect,
  useConnectAccount,
  useConnectingAccount,
} from '../../../daemon/account-queries';

const WRAP = { overflowWrap: 'anywhere' } as const;

/**
 * Signs an account in from the app: the daemon has Claude Code or Codex start the sign-in in the account's
 * own directory, the app opens the page when one is named (Claude Code opens the browser itself), and the
 * end arrives as an event. Whether a sign-in is waiting is the daemon's answer, not this component's
 * memory, so a drawer opened later, in another window or after a restart shows the truth. The login is
 * written by the agent; 10db never sees it. A finished sign-in calls `onConnected`, which runs the
 * identity check.
 */
export function ConnectAccount({
  account,
  onConnected,
}: {
  readonly account: AccountDto;
  readonly onConnected: () => void;
}) {
  const queryClient = useQueryClient();
  const slot = useConnectingAccount();
  const connect = useConnectAccount();
  const cancel = useCancelConnect();
  const { isError: connectError, reset: resetConnect } = connect;
  const { reset: resetCancel } = cancel;
  const ended = useAccountLoginEnd(account.id);
  const [confirming, setConfirming] = useState(false);
  // Set at the click: the mutation's own pending state is not visible to a second click in the same tick.
  const starting = useRef(false);

  // The sign-in finished: clear it, so a later render does not read it again, and check the identity.
  useEffect(() => {
    if (ended?.ok !== true) return;
    queryClient.setQueryData(accountLoginKey(account.id), null);
    // A refusal from an earlier Connect is stale now. A pending Connect is left alone: resetting it
    // would drop its settled callback.
    if (connectError) resetConnect();
    onConnected();
  }, [ended, account.id, queryClient, onConnected, connectError, resetConnect]);

  const holder = slot.data ?? null;
  const waiting = holder?.accountId === account.id;
  const elsewhere = holder !== null && !waiting ? holder : null;
  // A cancel the builder asked for is not an error.
  const failure =
    ended !== null && !ended.ok && !ended.cancelled
      ? ended.message
      : connect.isError
        ? connect.error.message
        : null;
  const stopping = cancel.isPending;
  const start = (settled?: () => void): void => {
    if (starting.current) return;
    starting.current = true;
    // The last sign-in's failed Cancel is not this one's.
    resetCancel();
    connect.mutate(account.id, {
      onSettled: () => {
        starting.current = false;
        settled?.();
      },
    });
  };

  if (waiting)
    return (
      <Stack gap="xs" align="flex-start">
        <Text size="sm" style={WRAP}>
          Waiting for you to sign in in your browser. This page updates when you are done.
        </Text>
        <Button
          size="md"
          variant="default"
          loading={stopping}
          onClick={() => {
            cancel.mutate(account.id);
          }}
        >
          Cancel
        </Button>
        {cancel.isError ? (
          <Alert color="red" role="alert" style={WRAP}>
            {cancel.error.message}
          </Alert>
        ) : null}
      </Stack>
    );

  if (confirming)
    return (
      <Stack gap="xs" align="flex-start">
        <Alert color="yellow" style={WRAP}>
          This is the login 10db already uses, and your own Claude Code login. Connecting signs in
          again and replaces it with the login you sign in with.
        </Alert>
        <Group>
          <Button
            size="md"
            loading={connect.isPending}
            onClick={() => {
              start(() => {
                setConfirming(false);
              });
            }}
          >
            Replace this login
          </Button>
          <Button
            size="md"
            variant="default"
            disabled={connect.isPending}
            onClick={() => {
              setConfirming(false);
            }}
          >
            Back
          </Button>
        </Group>
      </Stack>
    );

  return (
    <Stack gap="xs" align="flex-start">
      {elsewhere === null ? null : (
        <Stack gap="xs" align="flex-start">
          <Text size="sm" style={WRAP}>
            {elsewhere.label} is connecting. Finish or cancel that sign-in first.
          </Text>
          <Button
            size="compact-sm"
            variant="default"
            loading={stopping}
            aria-label={`Cancel ${elsewhere.label}’s sign-in`}
            onClick={() => {
              cancel.mutate(elsewhere.accountId);
            }}
          >
            Cancel
          </Button>
          {cancel.isError ? (
            <Alert color="red" role="alert" style={WRAP}>
              {cancel.error.message}
            </Alert>
          ) : null}
        </Stack>
      )}
      <Button
        size="md"
        loading={connect.isPending}
        disabled={elsewhere !== null || stopping}
        onClick={() => {
          if (account.isDefault) setConfirming(true);
          else start();
        }}
      >
        Connect
      </Button>
      {failure === null ? null : (
        <Alert color="red" role="alert" style={WRAP}>
          {failure}
        </Alert>
      )}
    </Stack>
  );
}
