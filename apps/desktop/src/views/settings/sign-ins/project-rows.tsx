import { LinearVia, type LinearSignInRowDto, type ProjectDto } from '@10db/contracts';
import { Button, Group, Stack, Switch, Text, TextInput } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useSlackConnection } from '../../../daemon/people';
import {
  useCancelLinearCheck,
  useCheckLinearTeam,
  useProjectIntegrations,
  useSetProjectIntegrations,
  useUnlinkLinear,
} from '../../../daemon/sign-in-queries';

/** One project on an integration's card: its name on the left, at most one control on the right. */
function ProjectRow({
  name,
  control,
  children,
}: {
  readonly name: string;
  readonly control?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <Stack gap={4}>
      <Group justify="space-between" wrap="nowrap" mih={30}>
        <Text size="sm" fw={500}>
          {name}
        </Text>
        {control}
      </Group>
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

/** A project's Linear: its team, or the key field and Link, or the check in flight, or why it can't. */
export function LinearProjectRow({
  project,
  row,
}: {
  readonly project: ProjectDto;
  /** The project's account's way to Linear. */
  readonly row: LinearSignInRowDto | undefined;
}) {
  const integrations = useProjectIntegrations(project.id);
  const check = useCheckLinearTeam(project.id);
  const unlink = useUnlinkLinear(project.id);
  const cancel = useCancelLinearCheck(project.id);
  const [teamKey, setTeamKey] = useState('');
  const linear = integrations.data?.linear;
  if (linear === undefined) return <ProjectRow name={project.name} />;
  // Only a definite none hides Link: an account whose connectors were not read yet may have Linear.
  const none = row?.via === LinearVia.None && !row.unchecked;
  const checking = linear.check?.state === 'checking' ? linear.check : null;
  const refused = linear.check?.state === 'refused' ? linear.check : null;
  const ended = linear.check?.state === 'ended' ? linear.check : null;
  const failure = check.isError
    ? check.error.message
    : unlink.isError
      ? unlink.error.message
      : cancel.isError
        ? cancel.error.message
        : null;
  const bound = linear.binding;
  let control: ReactNode;
  if (bound !== null)
    control = (
      <Button
        variant="default"
        size="xs"
        loading={unlink.isPending}
        onClick={() => {
          unlink.mutate();
        }}
      >
        Unlink
      </Button>
    );
  else if (checking !== null)
    control = (
      <Button
        variant="default"
        size="xs"
        loading={cancel.isPending}
        onClick={() => {
          cancel.mutate();
        }}
      >
        Cancel
      </Button>
    );
  let line: ReactNode = null;
  if (bound !== null)
    line = (
      <Text size="sm" c="dimmed">
        {bound.workspaceName} · {bound.teamKey}
      </Text>
    );
  else if (none)
    line = (
      <Text size="sm" c="dimmed">
        {row.note ?? "This project's account has no Linear sign-in."}
      </Text>
    );
  else if (checking !== null)
    line = (
      <Text size="sm" c="dimmed">
        Checking {checking.teamKey} in{' '}
        <Link to="/sessions" search={{ chat: checking.chatId }}>
          its session
        </Link>
        .
      </Text>
    );
  else if (ended !== null)
    line = (
      <Text size="sm" c="red">
        The check ended without an answer.{' '}
        <Link to="/sessions" search={{ chat: ended.chatId }}>
          Open its session
        </Link>
        .
      </Text>
    );
  else if (refused !== null)
    line = (
      <Text size="sm" c="red">
        {refused.reason}
      </Text>
    );
  const asksForTeam = bound === null && !none && checking === null;
  return (
    <ProjectRow name={project.name} control={control}>
      {line}
      {asksForTeam ? (
        <Group gap="xs" wrap="nowrap">
          <TextInput
            aria-label={`Linear team key for ${project.name}`}
            placeholder="Team key, such as AMP"
            value={teamKey}
            onChange={(event) => {
              setTeamKey(event.currentTarget.value);
            }}
          />
          <Button
            loading={check.isPending}
            disabled={teamKey.trim() === ''}
            onClick={() => {
              check.mutate(teamKey);
            }}
          >
            {refused === null && ended === null ? 'Link' : 'Link again'}
          </Button>
        </Group>
      ) : null}
      {failure === null ? null : (
        <Text size="xs" c="red">
          {failure}
        </Text>
      )}
    </ProjectRow>
  );
}
