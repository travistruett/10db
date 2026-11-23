import {
  FigmaVia,
  LinearVia,
  type FigmaSignInRowDto,
  type LinearSignInRowDto,
  type ProjectDto,
} from '@10db/contracts';
import {
  ActionIcon,
  Collapse,
  Divider,
  Group,
  Stack,
  Switch,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { ConnectionStatus, ConnectionTone } from '../connection-status';
import { ConnectServiceButton } from './connect-service-button';
import { useSlackConnection } from '../../../daemon/people';
import {
  useProjectIntegrations,
  useSetLinearReporter,
  useSetProjectIntegrations,
} from '../../../daemon/sign-in-queries';

/** One project on an integration's card, on one line: its name on the left, what it has on the right. */
export function ProjectRow({
  name,
  control,
  children,
}: {
  readonly name: string;
  readonly control?: ReactNode;
  /** Under the line, for a failure only. */
  readonly children?: ReactNode;
}) {
  return (
    <Stack gap={2}>
      <Group justify="space-between" wrap="nowrap" mih={36}>
        <Text size="sm" fw={500}>
          {name}
        </Text>
        {control}
      </Group>
      {children}
    </Stack>
  );
}

/** The projects of a card: a thin divider above the first, then one row each. */
export function ProjectRows({ children }: { readonly children: ReactNode }) {
  return (
    <Stack gap={0}>
      <Divider mb={4} />
      {children}
    </Stack>
  );
}

/** A project's Slack: one switch for sending its questions through the signed-in workspace. */
export function SlackProjectRow({ project }: { readonly project: ProjectDto }) {
  const integrations = useProjectIntegrations(project.id);
  const save = useSetProjectIntegrations(project.id);
  const connection = useSlackConnection();
  const signedIn = connection.data?.teamId ?? null;
  const slack = integrations.data?.slack;
  return (
    <ProjectRow
      name={project.name}
      control={
        slack === undefined ? undefined : (
          <Switch
            aria-label={`Slack for ${project.name}`}
            checked={slack.teamId !== null}
            disabled={save.isPending}
            onChange={(event) => {
              save.mutate({ slack: { teamId: event.currentTarget.checked ? signedIn : null } });
            }}
          />
        )
      }
    >
      {save.isError ? (
        <Text size="xs" c="red">
          {save.error.message}
        </Text>
      ) : null}
    </ProjectRow>
  );
}

/**
 * A project's Linear: when its account reaches Linear, or might, the Update Linear Issues switch and the note the
 * reporter follows; when the account definitely has none, or its server isn't signed in, Connect Linear.
 */
export function LinearProjectRow({
  project,
  row,
}: {
  readonly project: ProjectDto;
  /** The project's account's way to Linear. */
  readonly row: LinearSignInRowDto | undefined;
}) {
  const integrations = useProjectIntegrations(project.id);
  const save = useSetLinearReporter(project.id);
  const [editing, setEditing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const linear = integrations.data?.linear;
  if (linear === undefined) return <ProjectRow name={project.name} />;
  // Only a definite none, or a server not signed in, hides the switch: an account whose connectors were not
  // read yet may have Linear.
  const needsConnect =
    row !== undefined &&
    ((row.via === LinearVia.None && !row.unchecked) ||
      (row.via === LinearVia.Server && row.signedIn === false));
  if (row !== undefined && (needsConnect || connecting))
    return (
      <ProjectRow
        name={project.name}
        control={
          <ConnectServiceButton
            service="linear"
            projectId={project.id}
            accountId={row.accountId}
            serverKey={row.serverKey}
            signedIn={row.signedIn}
            // A Codex account's updates turn on in the daemon when its sign-in ends; a Claude Code sign-in
            // is the builder's, so the project's updates turn on once they say it's done.
            onConnected={() => {
              if (!linear.on) save.mutate({ on: true, note: linear.note });
            }}
            onStarted={() => {
              setConnecting(true);
            }}
            onFinished={() => {
              setConnecting(false);
              void integrations.refetch();
            }}
          />
        }
      />
    );
  const noteLabel = `${editing ? 'Hide' : 'Edit'} How To Update Linear for ${project.name}`;
  return (
    <ProjectRow
      name={project.name}
      control={
        <Group gap="xs" wrap="nowrap">
          <Tooltip label={editing ? 'Hide Update Note' : 'Edit Update Note'} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={noteLabel}
              aria-expanded={editing}
              onClick={() => {
                setEditing((was) => !was);
              }}
            >
              {editing ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
            </ActionIcon>
          </Tooltip>
          <Switch
            aria-label={`Update Linear Issues for ${project.name}`}
            label="Update Linear Issues"
            labelPosition="left"
            checked={linear.on}
            disabled={save.isPending}
            onChange={(event) => {
              save.mutate({ on: event.currentTarget.checked, note: linear.note });
            }}
          />
        </Group>
      }
    >
      <Collapse expanded={editing}>
        <Textarea
          // Keyed by the saved note, so a save from elsewhere replaces what the field shows.
          key={linear.note}
          size="xs"
          autosize
          minRows={2}
          label="How To Update Linear"
          aria-label={`How To Update Linear for ${project.name}`}
          placeholder="Optional: how updates to Linear should read"
          defaultValue={linear.note}
          onBlur={(event) => {
            const note = event.currentTarget.value;
            if (note !== linear.note) save.mutate({ on: linear.on, note });
          }}
        />
      </Collapse>
      {/* The switch already says off; only the Trust reason needs a line. */}
      {linear.blockedBy === null || !linear.on ? null : (
        <Text size="xs" c="dimmed">
          {linear.blockedBy}
        </Text>
      )}
      {save.isError ? (
        <Text size="xs" c="red">
          {save.error.message}
        </Text>
      ) : null}
    </ProjectRow>
  );
}

/**
 * A project's Figma: Connect Figma when its account definitely has none, or its server isn't signed in; otherwise
 * a quiet connected state. An account whose connectors were not read may have Figma, so it is not asked to connect.
 */
export function FigmaProjectRow({
  project,
  row,
}: {
  readonly project: ProjectDto;
  /** The project's account's way to Figma. */
  readonly row: FigmaSignInRowDto | undefined;
}) {
  const [connecting, setConnecting] = useState(false);
  if (row === undefined) return <ProjectRow name={project.name} />;
  const needsConnect =
    (row.via === FigmaVia.None && !row.unchecked) ||
    (row.via === FigmaVia.Server && row.signedIn === false);
  if (needsConnect || connecting)
    return (
      <ProjectRow
        name={project.name}
        control={
          <ConnectServiceButton
            service="figma"
            projectId={project.id}
            accountId={row.accountId}
            serverKey={row.serverKey}
            signedIn={row.signedIn}
            onStarted={() => {
              setConnecting(true);
            }}
            onFinished={() => {
              setConnecting(false);
            }}
          />
        }
      />
    );
  if (row.via === FigmaVia.None) return <ProjectRow name={project.name} />;
  return (
    <ProjectRow
      name={project.name}
      control={
        <ConnectionStatus
          tone={ConnectionTone.Works}
          label={row.via === FigmaVia.Connector ? 'Through claude.ai' : 'Connected'}
        />
      }
    />
  );
}
