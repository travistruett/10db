import { SendMode, type SlackMemberDto } from '@10db/contracts';
import { Alert, Button, Group, List, PasswordInput, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import {
  usePeople,
  useRemoveSlackToken,
  useSavePerson,
  useSetSlackToken,
  useSlackConnection,
} from '../../../daemon/people';
import { ExternalLink } from '../../board/pull-request-link';
import { MemberSelect } from './member-select';
import { DEFAULT_DAILY_LIMIT } from './person-modal';
import { SLACK_APPS_URL, SLACK_MANIFEST } from './slack-manifest';

/**
 * Which Slack member is the builder. Messages name the builder, so connecting is unfinished until the
 * builder's own person is bound to their Slack member; the member's name becomes the builder's name.
 */
function WhichIsYou() {
  const people = usePeople();
  const save = useSavePerson();
  const [picked, setPicked] = useState<SlackMemberDto | null>(null);
  const builder = people.data?.find((p) => p.isBuilder);
  if (builder?.slack !== null) return null;
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        Which one is you?
      </Text>
      <Group align="flex-end" gap="sm" wrap="nowrap">
        <div style={{ flex: 1 }}>
          <MemberSelect value={picked} onPick={setPicked} />
        </div>
        <Button
          disabled={picked === null}
          loading={save.isPending}
          onClick={() => {
            if (picked === null) return;
            save.mutate({
              id: builder.id,
              input: {
                handle: builder.handle,
                name: picked.realName,
                slack: {
                  teamId: picked.teamId,
                  userId: picked.userId,
                  sendMode: SendMode.Review,
                  dailyLimit: DEFAULT_DAILY_LIMIT,
                },
              },
            });
          }}
        >
          That's Me
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        Slack questions say whose build is asking. Until you pick yourself, they can't be sent.
      </Text>
      {save.isError ? (
        <Alert color="red" variant="light">
          {save.error.message}
        </Alert>
      ) : null}
    </Stack>
  );
}

/** Slack's state, and the three steps that connect it. */
export function SlackConnection() {
  const connection = useSlackConnection();
  const setToken = useSetSlackToken();
  const remove = useRemoveSlackToken();
  const [token, setTokenText] = useState('');
  const [copied, setCopied] = useState(false);
  const state = connection.data?.state ?? 'off';

  if (connection.isError)
    return (
      <Alert color="red" title="Couldn't load the Slack connection">
        {connection.error.message}
      </Alert>
    );
  if (state === 'connected' || state === 'unreachable' || state === 'refused') {
    const data = connection.data;
    return (
      <Stack gap="xs">
        <Group justify="space-between">
          <Text size="sm">
            {state === 'connected' ? (
              <>Connected to {data?.teamName ?? 'Slack'} · as @10db</>
            ) : state === 'refused' ? (
              "Slack refused 10db's token. Paste a new one below."
            ) : (
              'Slack could not be reached.'
            )}
          </Text>
          <Button
            variant="default"
            size="xs"
            loading={remove.isPending}
            onClick={() => {
              remove.mutate();
            }}
          >
            Disconnect
          </Button>
        </Group>
        {state === 'connected' ? <WhichIsYou /> : null}
        {state === 'refused' ? (
          <TokenField token={token} setToken={setTokenText} disabled={false} setter={setToken} />
        ) : null}
        {data?.error ? (
          <Text size="xs" c="dimmed">
            {data.error}
          </Text>
        ) : null}
      </Stack>
    );
  }
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        Slack is not connected
      </Text>
      <List type="ordered" size="sm" spacing="xs">
        <List.Item>
          <Group gap="sm">
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                void navigator.clipboard.writeText(SLACK_MANIFEST).then(() => {
                  setCopied(true);
                });
              }}
            >
              Copy Manifest
            </Button>
            <ExternalLink url={SLACK_APPS_URL} label="Open Slack Apps ↗" />
            {copied ? (
              <Text size="xs" c="dimmed">
                Copied
              </Text>
            ) : null}
          </Group>
        </List.Item>
        <List.Item>
          Create the app from the manifest and install it in your workspace
          <Text span size="xs" c="dimmed">
            {' '}
            (a workspace that needs approval sends a request first).
          </Text>
        </List.Item>
        <List.Item>Paste the Bot User OAuth Token below and press Connect.</List.Item>
      </List>
      <TokenField token={token} setToken={setTokenText} disabled={false} setter={setToken} />
    </Stack>
  );
}

function TokenField({
  token,
  setToken,
  disabled,
  setter,
}: {
  readonly token: string;
  readonly setToken: (value: string) => void;
  readonly disabled: boolean;
  readonly setter: ReturnType<typeof useSetSlackToken>;
}) {
  return (
    <Group align="flex-start" gap="sm" wrap="nowrap">
      <PasswordInput
        aria-label="Bot User OAuth Token"
        placeholder="xoxb-…"
        style={{ flex: 1 }}
        value={token}
        error={setter.isError ? setter.error.message : undefined}
        onChange={(event) => {
          setToken(event.currentTarget.value);
        }}
      />
      <Button
        disabled={disabled || token.trim() === ''}
        loading={setter.isPending}
        onClick={() => {
          setter.mutate(token.trim(), {
            onSuccess: () => {
              setToken('');
            },
          });
        }}
      >
        Connect
      </Button>
    </Group>
  );
}
