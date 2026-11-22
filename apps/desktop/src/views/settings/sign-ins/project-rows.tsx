import { LinearVia, type LinearSignInRowDto, type ProjectDto } from '@10db/contracts';
import { Divider, Group, Stack, Switch, Text, Textarea } from '@mantine/core';
import type { ReactNode } from 'react';
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
 * A project's Linear: when its account reaches Linear, or might, the Report To Linear switch and the note the
 * reporter follows; when the account definitely has none, the row's hint.
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
  const linear = integrations.data?.linear;
  if (linear === undefined) return <ProjectRow name={project.name} />;
  // Only a definite none hides the switch: an account whose connectors were not read yet may have Linear.
  const none = row?.via === LinearVia.None && !row.unchecked;
  if (none)
    return (
      <ProjectRow
        name={project.name}
        control={
          <Text size="sm" c="dimmed" ta="right" maw={420}>
            {row.note ?? "This project's account has no Linear sign-in."}
          </Text>
        }
      />
    );
  return (
    <ProjectRow
      name={project.name}
      control={
        <Switch
          aria-label={`Report To Linear for ${project.name}`}
          label="Report To Linear"
          labelPosition="left"
          checked={linear.on}
          disabled={save.isPending}
          onChange={(event) => {
            save.mutate({ on: event.currentTarget.checked, note: linear.note });
          }}
        />
      }
    >
      <Textarea
        // Keyed by the saved note, so a save from elsewhere replaces what the field shows.
        key={linear.note}
        size="xs"
        autosize
        minRows={2}
        label="How To Update Linear"
        aria-label={`How To Update Linear for ${project.name}`}
        defaultValue={linear.note}
        onBlur={(event) => {
          const note = event.currentTarget.value;
          if (note !== linear.note) save.mutate({ on: linear.on, note });
        }}
      />
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
