import type { ProjectDto } from '@10db/contracts';
import { Alert, Group, Paper, Skeleton, Stack, Switch, Text } from '@mantine/core';
import { IconBrandGithub, IconBrandSlack } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useSlackConnection } from '../../daemon/people';
import { useProjectIntegrations, useSetProjectIntegrations } from '../../daemon/sign-in-queries';
import { SettingsSectionKey } from './sections';

/** What Slack does for the project, in one line under its switch. */
function slackNote(slack: { teamId: string | null; teamName: string | null; auto: boolean }) {
  if (slack.teamId !== null)
    return slack.auto
      ? 'Bound automatically while this is the only workspace signed in.'
      : 'This project sends and reads questions in this workspace.';
  return 'Questions for other people stay in the Inbox; nothing is sent from this project.';
}

/**
 * Settings › Integrations (This Project): the GitHub login the project uses, and its Slack workspace. The
 * sign-ins themselves are in All Projects › Sign-ins.
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
  const { github, slack } = integrations.data;
  // The workspace signed in, which turning Slack on binds; with none there is nothing to turn on.
  const signedIn = connection.data?.teamId ?? null;
  const workspaceName = slack.teamName ?? connection.data?.teamName ?? null;
  return (
    <Stack>
      <Text c="dimmed" size="sm">
        The sign-ins {project.name} uses. Sign in once for every project under{' '}
        <Link to="/settings/$section" params={{ section: SettingsSectionKey.SignIns }}>
          Sign-ins
        </Link>
        .
      </Text>
      <Paper withBorder radius="md" p="md" aria-label="GitHub" role="group">
        <Group gap="sm" wrap="nowrap">
          <IconBrandGithub size={20} stroke={1.5} aria-hidden />
          <Stack gap={0}>
            <Text fw={600}>GitHub</Text>
            <Text size="sm" c="dimmed">
              {github.login === null
                ? 'No GitHub login read yet. Check Sign-ins; pull requests wait until gh is signed in.'
                : `Pull requests open and checks are watched as ${github.login}.`}
            </Text>
          </Stack>
        </Group>
      </Paper>
      <Paper withBorder radius="md" p="md" aria-label="Slack" role="group">
        <Stack gap="xs">
          <Group gap="sm" wrap="nowrap" justify="space-between">
            <Group gap="sm" wrap="nowrap">
              <IconBrandSlack size={20} stroke={1.5} aria-hidden />
              <Text fw={600}>Slack</Text>
            </Group>
            <Switch
              aria-label="Slack for this project"
              label={workspaceName ?? 'No workspace signed in'}
              checked={slack.teamId !== null}
              disabled={save.isPending || (slack.teamId === null && signedIn === null)}
              onChange={(event) => {
                save.mutate({ slack: { teamId: event.currentTarget.checked ? signedIn : null } });
              }}
            />
          </Group>
          <Text size="sm" c="dimmed">
            {slackNote(slack)}
          </Text>
          {save.isError ? (
            <Text size="sm" c="red">
              {save.error.message}
            </Text>
          ) : null}
        </Stack>
      </Paper>
    </Stack>
  );
}
