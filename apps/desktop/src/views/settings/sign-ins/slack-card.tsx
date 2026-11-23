import { contactIn, type PersonDto, type SlackWorkspaceStatusDto } from '@10db/contracts';
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
  useRemoveSlackWorkspace,
  useSetSlackToken,
  useSlackMember,
  useSlackStatus,
} from '../../../daemon/people';
import { ConfirmModal } from '../../../shell/confirm-modal';
import { ExternalLink } from '../../board/pull-request-link';
import { IntegrationCard, StateText } from './integration-card';
import { ProjectRows, SlackProjectRow } from './project-rows';
import { SLACK_APPS_URL, SLACK_MANIFEST } from './slack-manifest';
import { WhichIsYou } from './which-is-you';

/** What a workspace that is not connected is doing, in a dim line under its row. */
function stateNote(workspace: SlackWorkspaceStatusDto): string | null {
  switch (workspace.state) {
    case 'connected':
      return null;
    case 'checking':
      return 'Checking…';
    case 'none':
      return 'Not connected: its token is gone from your Keychain. Replace it to reconnect.';
    case 'refused':
      return "Slack refused 10db's token. Paste a new one to reconnect.";
    case 'unreachable':
      return "Slack can't be reached. 10db keeps trying, once a minute.";
  }
}

/** "Acme · posts as @10db · you're @travis": the workspace in one line. */
function WorkspaceLine({
  workspace,
  builder,
}: {
  readonly workspace: SlackWorkspaceStatusDto;
  readonly builder: PersonDto | undefined;
}) {
  const contact = builder === undefined ? null : contactIn(builder, workspace.teamId);
  const member = useSlackMember(workspace.teamId, contact?.userId ?? null);
  const parts = [workspace.teamName, `posts as @${workspace.botName ?? '10db'}`];
  if (builder !== undefined && contact !== null)
    parts.push(`you're @${member?.name ?? builder.name}`);
  return (
    <Text size="sm" fw={500}>
      {parts.join(' · ')}
    </Text>
  );
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

/** The three steps that connect a workspace, ending in the token field. */
function SetupSteps({
  adding,
  onConnected,
}: {
  /** Another workspace beside the ones already listed. */
  readonly adding: boolean;
  readonly onConnected?: () => void;
}) {
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
      <SetupStep
        n={2}
        title={
          adding
            ? "Create an app from it in Slack and install it in the workspace you're adding."
            : 'Create an app from it in Slack and install it in your workspace.'
        }
      >
        <Group gap="sm">
          <ExternalLink url={SLACK_APPS_URL} label="Open Slack Apps ↗" />
          <Text size="xs" c="dimmed">
            A workspace that needs approval sends a request first.
          </Text>
        </Group>
      </SetupStep>
      <SetupStep n={3} title="Paste its Bot User OAuth Token.">
        <TokenField connectLabel="Connect" onDone={onConnected} />
      </SetupStep>
    </Stack>
  );
}

/**
 * The token field. With a `teamId` it replaces that workspace's token, and Slack's refusal of another team's
 * token is its error; without one it adds a workspace.
 */
function TokenField({
  teamId,
  connectLabel,
  onDone,
}: {
  readonly teamId?: string;
  readonly connectLabel: string;
  readonly onDone?: (() => void) | undefined;
}) {
  const setter = useSetSlackToken();
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
          setter.mutate(
            teamId === undefined ? { token: token.trim() } : { token: token.trim(), teamId },
            {
              onSuccess: () => {
                setToken('');
                onDone?.();
              },
              onError: (failure) => {
                setRefusal(failure.message);
              },
              // The mutation's variables are the token; drop them whichever way it went.
              onSettled: () => {
                setter.reset();
              },
            },
          );
        }}
      >
        {connectLabel}
      </Button>
    </Group>
  );
}

/** One signed-in workspace: its line, its menu, and what it needs under it (a new token, who you are). */
function WorkspaceRow({
  workspace,
  builder,
  readOnly,
}: {
  readonly workspace: SlackWorkspaceStatusDto;
  readonly builder: PersonDto | undefined;
  /** 10db was started with Slack off: the rows are listed and nothing is changed from them. */
  readonly readOnly: boolean;
}) {
  const remove = useRemoveSlackWorkspace();
  const [replacing, setReplacing] = useState(false);
  const [changing, setChanging] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const contact = builder === undefined ? null : contactIn(builder, workspace.teamId);
  const note = stateNote(workspace);
  const connected = workspace.state === 'connected';
  return (
    <Stack gap={4}>
      <Group justify="space-between" wrap="nowrap" mih={30}>
        <Stack gap={0} miw={0}>
          <WorkspaceLine workspace={workspace} builder={builder} />
          {note === null ? null : <StateText>{note}</StateText>}
        </Stack>
        {readOnly ? null : (
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" aria-label={`${workspace.teamName} options`}>
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {connected && contact !== null ? (
                <Menu.Item
                  onClick={() => {
                    setChanging(true);
                  }}
                >
                  Change Who You Are
                </Menu.Item>
              ) : null}
              <Menu.Item
                onClick={() => {
                  setReplacing(true);
                }}
              >
                Replace Token
              </Menu.Item>
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
        )}
      </Group>
      {!readOnly && (replacing || workspace.state === 'refused') ? (
        <TokenField
          teamId={workspace.teamId}
          connectLabel="Replace"
          onDone={() => {
            setReplacing(false);
          }}
        />
      ) : null}
      {connected && builder && (contact === null || changing) ? (
        <WhichIsYou
          builder={builder}
          teamId={workspace.teamId}
          changing={contact !== null}
          onDone={() => {
            setChanging(false);
          }}
        />
      ) : null}
      {workspace.error ? (
        <Text size="xs" c="dimmed">
          {workspace.error}
        </Text>
      ) : null}
      <ConfirmModal
        opened={disconnecting}
        title={`Disconnect ${workspace.teamName}?`}
        confirmLabel="Disconnect"
        destructive
        loading={remove.isPending}
        error={remove.isError ? remove.error.message : null}
        onCancel={() => {
          setDisconnecting(false);
        }}
        onConfirm={() => {
          remove.mutate(workspace.teamId, {
            onSuccess: () => {
              setDisconnecting(false);
            },
          });
        }}
      >
        10db stops sending and reading {workspace.teamName}'s Slack and removes its token from your
        Keychain. Its projects send nothing until it is connected again. Questions already sent
        there stay in your Inbox.
      </ConfirmModal>
    </Stack>
  );
}

/** One row per project, each choosing which signed-in workspace its questions go through, or Off. */
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
 * Settings › Integrations › Slack. One row per signed-in workspace, each with a small menu, and the three
 * setup steps: shown alone while none is signed in, behind Add Workspace after that. A workspace where the
 * builder has no contact holds a Which One Is You under its row.
 */
export function SlackCard() {
  const status = useSlackStatus();
  const people = usePeople();
  const [adding, setAdding] = useState(false);
  const data = status.data;
  const builder = people.data?.find((p) => p.isBuilder);
  const workspaces = data?.workspaces ?? [];
  const off = data?.off === true;

  // The card appears once its state is read, so a link's focus lands on its controls.
  if (!data && !status.isError) return <Skeleton height={90} radius="md" />;
  return (
    <IntegrationCard
      mark={<IconBrandSlack size={20} stroke={1.5} aria-hidden />}
      name="Slack"
      focusName="slack"
    >
      {status.isError ? <StateText>Couldn't read this.</StateText> : null}
      {off ? <StateText>Off: 10db was started with TENDB_SLACK=off</StateText> : null}
      {data && !off && workspaces.length === 0 ? <StateText>Not connected.</StateText> : null}
      {status.isError ? (
        <Alert color="red" title="Couldn't load the Slack connection">
          {status.error.message}
        </Alert>
      ) : null}
      {workspaces.map((workspace) => (
        <WorkspaceRow
          key={workspace.teamId}
          workspace={workspace}
          builder={builder}
          readOnly={off}
        />
      ))}
      {data && !off && workspaces.length === 0 ? <SetupSteps adding={false} /> : null}
      {data && !off && workspaces.length > 0 ? (
        adding ? (
          <SetupSteps
            adding
            onConnected={() => {
              setAdding(false);
            }}
          />
        ) : (
          <Group>
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                setAdding(true);
              }}
            >
              Add Workspace
            </Button>
          </Group>
        )
      ) : null}
      {workspaces.length > 0 ? <SlackProjects /> : null}
    </IntegrationCard>
  );
}
