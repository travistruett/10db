import {
  FigmaVia,
  LinearVia,
  type FigmaSignInRowDto,
  type LinearSignInRowDto,
  type ProjectDto,
} from '@10db/contracts';
import { Divider, Group, Select, Stack, Switch, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { ConnectionStatus, ConnectionTone } from '../connection-status';
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
              // Decided on a fresh count: a question may have gone out since the page last read it.
              void integrations.refetch().then((fresh) => {
                if ((fresh.data?.slack.out ?? slack.out) > 0) setAsked({ teamId });
                else change(teamId);
              });
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
        {slack?.teamName == null ? 'Slack' : `${slack.teamName}'s Slack`} come back to you.
      </ConfirmModal>
    </ProjectRow>
  );
}

/**
 * A project's Linear: when its account reaches Linear, or might, its on/off switch (on, a task from a Linear issue
 * keeps the issue updated); when the account definitely has none, or its server isn't signed in, Connect Linear.
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
  return (
    <ProjectRow
      name={project.name}
      control={
        <Switch
          aria-label={`Linear for ${project.name}`}
          checked={linear.on}
          disabled={save.isPending}
          onChange={(event) => {
            save.mutate({ on: event.currentTarget.checked, note: linear.note });
          }}
        />
      }
    >
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
