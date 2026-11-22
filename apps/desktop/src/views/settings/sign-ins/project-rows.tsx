import { LinearVia, type LinearSignInRowDto, type ProjectDto } from '@10db/contracts';
import { Button, Divider, Group, Stack, Switch, Text, TextInput } from '@mantine/core';
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
  const key = (
    <Group gap="xs" wrap="nowrap">
      <TextInput
        size="xs"
        aria-label={`Linear team key for ${project.name}`}
        placeholder="Team key, such as AMP"
        value={teamKey}
        onChange={(event) => {
          setTeamKey(event.currentTarget.value);
        }}
      />
      <Button
        size="xs"
        loading={check.isPending}
        disabled={teamKey.trim() === ''}
        onClick={() => {
          check.mutate(teamKey);
        }}
      >
        {refused === null && ended === null ? 'Link' : 'Link again'}
      </Button>
    </Group>
  );
  const button = (label: string, loading: boolean, onClick: () => void) => (
    <Button variant="default" size="xs" loading={loading} onClick={onClick}>
      {label}
    </Button>
  );
  let control: ReactNode;
  if (bound !== null)
    control = (
      <Group gap="sm" wrap="nowrap">
        <Text size="sm" c="dimmed">
          {bound.workspaceName} · {bound.teamKey}
        </Text>
        {button('Unlink', unlink.isPending, () => {
          unlink.mutate();
        })}
      </Group>
    );
  else if (none)
    control = (
      <Text size="sm" c="dimmed" ta="right" maw={420}>
        {row.note ?? "This project's account has no Linear sign-in."}
      </Text>
    );
  else if (checking !== null)
    control = (
      <Group gap="sm" wrap="nowrap">
        <Text size="sm" c="dimmed">
          <Link to="/sessions" search={{ chat: checking.chatId }}>
            Checking {checking.teamKey}…
          </Link>
        </Text>
        {button('Cancel', cancel.isPending, () => {
          cancel.mutate();
        })}
      </Group>
    );
  else control = key;
  const note =
    ended !== null ? (
      <Text size="xs" c="red">
        The check ended without an answer.{' '}
        <Link to="/sessions" search={{ chat: ended.chatId }}>
          Open its session
        </Link>
        .
      </Text>
    ) : refused !== null ? (
      <Text size="xs" c="red">
        {refused.reason}
      </Text>
    ) : failure !== null ? (
      <Text size="xs" c="red">
        {failure}
      </Text>
    ) : null;
  return (
    <ProjectRow name={project.name} control={control}>
      {note}
    </ProjectRow>
  );
}
