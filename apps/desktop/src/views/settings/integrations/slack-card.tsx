import type { SlackConnectionDto } from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  List,
  Menu,
  Paper,
  PasswordInput,
  Stack,
  Text,
} from '@mantine/core';
import { IconBrandSlack, IconDots } from '@tabler/icons-react';
import { useState } from 'react';
import {
  usePeople,
  useRemoveSlackToken,
  useSetSlackToken,
  useSlackConnection,
  useSlackMember,
} from '../../../daemon/people';
import { ConfirmModal } from '../../../shell/confirm-modal';
import { ExternalLink } from '../../board/pull-request-link';
import { SLACK_APPS_URL, SLACK_MANIFEST } from './slack-manifest';
import { WhichIsYou } from './which-is-you';

/** "Ampsio · posts as @10db · you're @Travis Truett": the connection in one line. */
function ConnectedLine({ connection }: { readonly connection: SlackConnectionDto }) {
  const builder = usePeople().data?.find((p) => p.isBuilder);
  const member = useSlackMember(builder?.slack?.userId ?? null);
  const parts = [connection.teamName ?? 'Slack', 'posts as @10db'];
  if (builder?.slack) parts.push(`you're @${member?.name ?? builder.name}`);
  return <Text size="sm">{parts.join(' · ')}</Text>;
}

/** The three steps that connect Slack, ending in the token field. */
function SetupSteps() {
  const setToken = useSetSlackToken();
  const [copied, setCopied] = useState(false);
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Ask the people who answer your questions in Slack, and read their replies there.
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
      <TokenField setter={setToken} />
    </Stack>
  );
}

function TokenField({ setter }: { readonly setter: ReturnType<typeof useSetSlackToken> }) {
  const [token, setToken] = useState('');
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
        disabled={token.trim() === ''}
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

/**
 * Settings › Integrations › Slack. Not connected, it is the three setup steps; connected, one line,
 * with Change Who You Are and Disconnect in a small menu. Until the builder picks their own member,
 * the card holds a callout to finish setup.
 */
export function SlackCard() {
  const connection = useSlackConnection();
  const people = usePeople();
  const remove = useRemoveSlackToken();
  const setToken = useSetSlackToken();
  const [changing, setChanging] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const data = connection.data;
  const state = data?.state ?? 'off';
  const live = state === 'connected' || state === 'unreachable' || state === 'refused';
  const builder = people.data?.find((p) => p.isBuilder);
  const bound = builder !== undefined && builder.slack !== null;

  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <IconBrandSlack size={20} stroke={1.5} aria-hidden />
            <Text fw={600}>Slack</Text>
          </Group>
          {live ? (
            <Menu position="bottom-end">
              <Menu.Target>
                <ActionIcon variant="subtle" aria-label="Slack options">
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {state === 'connected' && bound ? (
                  <Menu.Item
                    onClick={() => {
                      setChanging(true);
                    }}
                  >
                    Change Who You Are
                  </Menu.Item>
                ) : null}
                <Menu.Item
                  color="red"
                  onClick={() => {
                    setDisconnecting(true);
                  }}
                >
                  Disconnect
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          ) : null}
        </Group>
        {connection.isError ? (
          <Alert color="red" title="Couldn't load the Slack connection">
            {connection.error.message}
          </Alert>
        ) : null}
        {connection.isSuccess && !live ? <SetupSteps /> : null}
        {state === 'connected' && data ? <ConnectedLine connection={data} /> : null}
        {state === 'connected' && builder && (!bound || changing) ? (
          <WhichIsYou
            builder={builder}
            changing={bound}
            onDone={() => {
              setChanging(false);
            }}
          />
        ) : null}
        {state === 'refused' ? (
          <>
            <Text size="sm">Slack refused 10db's token. Paste a new one to reconnect.</Text>
            <TokenField setter={setToken} />
          </>
        ) : null}
        {state === 'unreachable' ? (
          <Text size="sm">Slack can't be reached. 10db keeps trying, once a minute.</Text>
        ) : null}
        {data?.error ? (
          <Text size="xs" c="dimmed">
            {data.error}
          </Text>
        ) : null}
      </Stack>
      <ConfirmModal
        opened={disconnecting}
        title="Disconnect Slack?"
        confirmLabel="Disconnect"
        destructive
        loading={remove.isPending}
        error={remove.isError ? remove.error.message : null}
        onCancel={() => {
          setDisconnecting(false);
        }}
        onConfirm={() => {
          remove.mutate(undefined, {
            onSuccess: () => {
              setDisconnecting(false);
            },
          });
        }}
      >
        10db stops sending and reading Slack at once and removes its token from your Keychain.
        Questions already sent stay in your Inbox for you to answer yourself.
      </ConfirmModal>
    </Paper>
  );
}
