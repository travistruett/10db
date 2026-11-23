import { LinearVia, type LinearSignInRowDto, type ProjectDto } from '@10db/contracts';
import {
  ActionIcon,
  Collapse,
  Divider,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { ConnectServiceButton } from './connect-service-button';
import { useSlackStatus } from '../../../daemon/people';
import { ConfirmModal } from '../../../shell/confirm-modal';
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

const SLACK_OFF = 'off';

/** A project's Slack: the signed-in workspace its questions go through, or Off. */
export function SlackProjectRow({ project }: { readonly project: ProjectDto }) {
  const integrations = useProjectIntegrations(project.id);
  const save = useSetProjectIntegrations(project.id);
  const status = useSlackStatus();
  // The workspace a pending change would move the project to; null is Off.
  const [asked, setAsked] = useState<{ readonly teamId: string | null } | null>(null);
  const slack = integrations.data?.slack;
  const workspaces = status.data?.workspaces ?? [];
  const change = (teamId: string | null) => {
    save.mutate({ slack: { teamId } });
  };
  return (
    <ProjectRow
      name={project.name}
      control={
        slack === undefined ? undefined : (
          <Select
            aria-label={`Slack for ${project.name}`}
            size="xs"
            w={180}
            allowDeselect={false}
            disabled={save.isPending}
            data={[
              ...workspaces.map((w) => ({ value: w.teamId, label: w.teamName })),
              { value: SLACK_OFF, label: 'Off' },
            ]}
            value={slack.teamId ?? SLACK_OFF}
            onChange={(value) => {
              if (value === null) return;
              const teamId = value === SLACK_OFF ? null : value;
              if (teamId === slack.teamId) return;
              if (slack.out > 0) setAsked({ teamId });
              else change(teamId);
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
      <ConfirmModal
        opened={asked !== null}
        title={`Change Slack for ${project.name}?`}
        confirmLabel={asked?.teamId === null ? 'Turn Off' : 'Change'}
        onCancel={() => {
          setAsked(null);
        }}
        onConfirm={() => {
          if (asked !== null) change(asked.teamId);
          setAsked(null);
        }}
      >
        {slack?.out ?? 0} {slack?.out === 1 ? 'question' : 'questions'} out in{' '}
        {slack?.teamName ?? 'its'}'s Slack come back to you.
      </ConfirmModal>
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
