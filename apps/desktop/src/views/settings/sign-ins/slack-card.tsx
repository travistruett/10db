import type { SlackConnectionDto } from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Menu,
  PasswordInput,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconBrandSlack, IconCopy, IconDots } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { useProjects } from '../../../daemon/queries';
import {
  usePeople,
  useRemoveSlackToken,
  useSetSlackToken,
  useSlackConnection,
  useSlackMember,
} from '../../../daemon/people';
import { ConfirmModal } from '../../../shell/confirm-modal';
import { ExternalLink } from '../../board/pull-request-link';
import { IntegrationCard, StateText } from './integration-card';
import { ProjectRows, SlackProjectRow } from './project-rows';
import { SLACK_APPS_URL, SLACK_MANIFEST } from './slack-manifest';
import { WhichIsYou } from './which-is-you';

/** "Acme · posts as @10db · you're @Travis": the connection in one line. */
function ConnectedLine({ teamName }: { readonly teamName: string | null }) {
  const builder = usePeople().data?.find((p) => p.isBuilder);
  const member = useSlackMember(builder?.slack?.userId ?? null);
  const parts = [...(teamName === null ? [] : [teamName]), 'posts as @10db'];
  if (builder?.slack) parts.push(`you're @${member?.name ?? builder.name}`);
  return <StateText>{parts.join(' · ')}</StateText>;
}

/** The card's one state line. */
function StateLine({
  connection,
  failed,
}: {
  readonly connection: SlackConnectionDto | undefined;
  readonly failed: boolean;
}) {
  if (failed) return <StateText>Couldn't read this.</StateText>;
  if (!connection) return null;
  switch (connection.state) {
    case 'connected':
      return <ConnectedLine teamName={connection.teamName} />;
    case 'none':
      return <StateText>Not connected.</StateText>;
    case 'refused':
      return <StateText>Slack refused 10db's token. Paste a new one to reconnect.</StateText>;
    case 'unreachable':
      return <StateText>Slack can't be reached. 10db keeps trying, once a minute.</StateText>;
    case 'off':
      return <StateText>Off: 10db was started with TENDB_SLACK=off</StateText>;
  }
}

/** One numbered setup step: its number in a circle, a short title, and what the step needs under it. */
function SetupStep({
  n,
  title,
  children,
}: {
  readonly n: number;
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start">
      <ThemeIcon size={22} radius="xl" variant="light" color="gray" style={{ flex: 'none' }}>
        <Text size="xs" fw={600}>
          {n}
        </Text>
      </ThemeIcon>
      <Stack gap={6} style={{ flex: 1 }} miw={0} pt={2}>
        <Text size="sm">{title}</Text>
        {children}
      </Stack>
    </Group>
  );
}

/** The three steps that connect Slack, ending in the token field. */
function SetupSteps() {
  const setToken = useSetSlackToken();
  const [copied, setCopied] = useState(false);
  return (
    <Stack gap="md" pt={4}>
      <SetupStep n={1} title="Copy 10db's app manifest.">
        <Group gap="sm">
          <Button
            size="xs"
            variant="default"
            leftSection={<IconCopy size={14} />}
            onClick={() => {
              void navigator.clipboard.writeText(SLACK_MANIFEST).then(() => {
                setCopied(true);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy Manifest'}
          </Button>
        </Group>
      </SetupStep>
      <SetupStep n={2} title="Create an app from it in Slack and install it in your workspace.">
        <Group gap="sm">
          <ExternalLink url={SLACK_APPS_URL} label="Open Slack Apps ↗" />
          <Text size="xs" c="dimmed">
            A workspace that needs approval sends a request first.
          </Text>
        </Group>
      </SetupStep>
      <SetupStep n={3} title="Paste its Bot User OAuth Token.">
        <TokenField setter={setToken} />
      </SetupStep>
    </Stack>
  );
}

function TokenField({ setter }: { readonly setter: ReturnType<typeof useSetSlackToken> }) {
  const [token, setToken] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  return (
    <Group align="flex-start" gap="sm" wrap="nowrap">
      <PasswordInput
        aria-label="Bot User OAuth Token"
        placeholder="xoxb-…"
        style={{ flex: 1 }}
        value={token}
        error={refusal ?? undefined}
        onChange={(event) => {
          setToken(event.currentTarget.value);
        }}
      />
      <Button
        disabled={token.trim() === ''}
        loading={setter.isPending}
        onClick={() => {
          setRefusal(null);
          setter.mutate(token.trim(), {
            onSuccess: () => {
              setToken('');
            },
            onError: (failure) => {
              setRefusal(failure.message);
            },
            // The mutation's variables are the token; drop them whichever way it went.
            onSettled: () => {
              setter.reset();
            },
          });
        }}
      >
        Connect
      </Button>
    </Group>
  );
}

/** One row per project, each with its own switch for sending questions through the signed-in workspace. */
function SlackProjects() {
  const projects = useProjects();
  const list = projects.data ?? [];
  if (list.length === 0) return null;
  return (
    <ProjectRows>
      {list.map((project) => (
        <SlackProjectRow key={project.id} project={project} />
      ))}
    </ProjectRows>
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
  const state = data?.state;
  const live = state === 'connected' || state === 'unreachable' || state === 'refused';
  const builder = people.data?.find((p) => p.isBuilder);
  const bound = builder !== undefined && builder.slack !== null;

  // The card appears once its state is read, so a link's focus lands on its controls.
  if (!data && !connection.isError) return <Skeleton height={90} radius="md" />;
  return (
    <IntegrationCard
      mark={<IconBrandSlack size={20} stroke={1.5} aria-hidden />}
      name="Slack"
      focusName="slack"
      control={
        live ? (
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
        ) : undefined
      }
    >
      <StateLine connection={data} failed={connection.isError} />
      {connection.isError ? (
        <Alert color="red" title="Couldn't load the Slack connection">
          {connection.error.message}
        </Alert>
      ) : null}
      {state === 'none' ? <SetupSteps /> : null}
      {state === 'connected' && builder && (!bound || changing) ? (
        <WhichIsYou
          builder={builder}
          changing={bound}
          onDone={() => {
            setChanging(false);
          }}
        />
      ) : null}
      {state === 'refused' ? <TokenField setter={setToken} /> : null}
      {state === 'connected' ? <SlackProjects /> : null}
      {data?.error ? (
        <Text size="xs" c="dimmed">
          {data.error}
        </Text>
      ) : null}
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
    </IntegrationCard>
  );
}
