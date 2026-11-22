import { LinearVia, type ProjectDto, type ProjectLinearDto } from '@10db/contracts';
import {
  Alert,
  Button,
  Group,
  Paper,
  Skeleton,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { IconBrandGithub, IconBrandSlack, IconListDetails } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useSlackConnection } from '../../daemon/people';
import {
  useCancelLinearCheck,
  useCheckLinearTeam,
  useLinearSignIns,
  useProjectIntegrations,
  useSetProjectIntegrations,
  useUnlinkLinear,
} from '../../daemon/sign-in-queries';
import { SettingsSectionKey } from './sections';

const SIGN_INS_LINK = (
  <Link to="/settings/$section" params={{ section: SettingsSectionKey.SignIns }}>
    Sign-ins
  </Link>
);

/** One integration: icon and name on the left, at most one control on the right, then its state lines. */
function IntegrationCard({
  name,
  icon,
  control,
  children,
}: {
  readonly name: string;
  readonly icon: ReactNode;
  readonly control?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Paper withBorder radius="md" p="md" aria-label={name} role="group">
      <Stack gap="xs">
        <Group gap="sm" wrap="nowrap" justify="space-between" mih={30}>
          <Group gap="sm" wrap="nowrap">
            {icon}
            <Text fw={600}>{name}</Text>
          </Group>
          {control}
        </Group>
        {children}
      </Stack>
    </Paper>
  );
}

/** What Linear is for the project: the linked team, a check in a session, the refusal, or the way to link one. */
function LinearBlock({
  project,
  linear,
}: {
  readonly project: ProjectDto;
  readonly linear: ProjectLinearDto;
}) {
  const signIns = useLinearSignIns();
  const check = useCheckLinearTeam(project.id);
  const unlink = useUnlinkLinear(project.id);
  const cancel = useCancelLinearCheck(project.id);
  const [teamKey, setTeamKey] = useState('');
  const row = signIns.data?.rows.find((r) => r.accountId === project.accountId);
  // Only a definite none hides Link: an account whose connectors were not read yet may have Linear, and the
  // check session finds out.
  const none = row?.via === LinearVia.None && !row.unchecked;
  const hint = row?.via === LinearVia.None ? row.note : null;
  const checking = linear.check?.state === 'checking' ? linear.check : null;
  const refused = linear.check?.state === 'refused' ? linear.check : null;
  const ended = linear.check?.state === 'ended' ? linear.check : null;
  const failure = check.isError
    ? check.error.message
    : unlink.isError
      ? unlink.error.message
      : null;
  const bound = linear.binding;
  const cancelButton =
    checking === null ? undefined : (
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
  const unlinkButton =
    bound === null ? undefined : (
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
  let state: ReactNode;
  if (bound !== null)
    state = (
      <Text size="sm" c="dimmed">
        {bound.workspaceName} · team {bound.teamKey} ({bound.teamName})
      </Text>
    );
  else if (none)
    state = (
      <Text size="sm" c="dimmed">
        {hint ?? "This project's account has no Linear sign-in."}
      </Text>
    );
  else if (checking !== null)
    state = (
      <Text size="sm" c="dimmed">
        Checking {checking.teamKey} in{' '}
        <Link to="/sessions" search={{ chat: checking.chatId }}>
          its session
        </Link>
        .
      </Text>
    );
  else if (ended !== null)
    state = (
      <Text size="sm" c="red">
        The check ended without an answer.{' '}
        <Link to="/sessions" search={{ chat: ended.chatId }}>
          Open its session
        </Link>
        .
      </Text>
    );
  else if (refused !== null)
    state = (
      <Text size="sm" c="red">
        {refused.reason}
      </Text>
    );
  else
    state = (
      <Text size="sm" c="dimmed">
        {hint ?? 'Not linked to a Linear team.'}
      </Text>
    );
  const asksForTeam = bound === null && !none && checking === null;
  return (
    <IntegrationCard
      name="Linear"
      icon={<IconListDetails size={20} stroke={1.5} aria-hidden />}
      control={unlinkButton ?? cancelButton}
    >
      {state}
      {asksForTeam ? (
        <Group gap="xs" wrap="nowrap">
          <TextInput
            aria-label="Linear team key"
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
        <Text size="sm" c="red">
          {failure}
        </Text>
      )}
    </IntegrationCard>
  );
}

/**
 * Settings › Integrations (This Project): the GitHub login the project uses, its Slack workspace and its Linear
 * team. The sign-ins themselves are in All Projects › Sign-ins.
 */
export function ProjectIntegrationsSection({ project }: { readonly project: ProjectDto }) {
  const integrations = useProjectIntegrations(project.id);
  const save = useSetProjectIntegrations(project.id);
  const connection = useSlackConnection();
  if (integrations.isPending) return <Skeleton height={160} radius="md" />;
  if (integrations.isError)
    return (
      <Alert color="red" title="Couldn't read this project's integrations">
        {integrations.error.message}
      </Alert>
    );
  const { github, slack, linear } = integrations.data;
  // The workspace signed in, which turning Slack on binds; with none there is nothing to turn on.
  const signedIn = connection.data?.teamId ?? null;
  const workspaceName = slack.teamName ?? connection.data?.teamName ?? null;
  const slackReady = slack.teamId !== null || signedIn !== null;
  return (
    <Stack>
      <Text c="dimmed" size="sm">
        The sign-ins {project.name} uses. Sign in once for every project under {SIGN_INS_LINK}.
      </Text>
      <IntegrationCard name="GitHub" icon={<IconBrandGithub size={20} stroke={1.5} aria-hidden />}>
        <Text size="sm" c="dimmed">
          {github.login === null ? (
            <>No GitHub login read yet. Sign in under {SIGN_INS_LINK}.</>
          ) : (
            `Signed in as ${github.login}`
          )}
        </Text>
      </IntegrationCard>
      <IntegrationCard
        name="Slack"
        icon={<IconBrandSlack size={20} stroke={1.5} aria-hidden />}
        control={
          slackReady ? (
            <Switch
              aria-label="Slack for this project"
              checked={slack.teamId !== null}
              disabled={save.isPending}
              onChange={(event) => {
                save.mutate({ slack: { teamId: event.currentTarget.checked ? signedIn : null } });
              }}
            />
          ) : undefined
        }
      >
        <Text size="sm" c="dimmed">
          {!slackReady ? (
            <>
              No Slack workspace signed in. Sign in under {SIGN_INS_LINK}; until then questions for
              other people stay in the Inbox.
            </>
          ) : slack.teamId !== null ? (
            `${workspaceName ?? 'Slack'} workspace · questions go to people in Slack`
          ) : (
            `${workspaceName ?? 'Slack'} workspace · off for this project, questions stay in the Inbox`
          )}
        </Text>
        {save.isError ? (
          <Text size="sm" c="red">
            {save.error.message}
          </Text>
        ) : null}
      </IntegrationCard>
      <LinearBlock project={project} linear={linear} />
    </Stack>
  );
}
