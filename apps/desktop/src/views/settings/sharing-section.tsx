import type { ProjectDto, SlackChannelDto } from '@10db/contracts';
import { Alert, Button, Group, Select, Skeleton, Stack, Switch, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useSlackStatus } from '../../daemon/people';
import {
  useProjectIntegrations,
  useSetSlackSharing,
  useSlackChannels,
  useSlackSharing,
} from '../../daemon/sign-in-queries';
import { useProjectFields } from './project-fields-state';
import { ProjectSaveBar } from './project-save-bar';
import { SettingsSectionKey } from './sections';
import { SettingRow, SettingsCard } from './setting-row';

const channelLabel = (channel: SlackChannelDto): string =>
  channel.isPrivate ? `${channel.name} (private)` : `#${channel.name}`;

function IntegrationsLink({ label }: { readonly label: string }) {
  return (
    <Button
      variant="default"
      size="compact-sm"
      renderRoot={(props) => (
        <Link
          {...props}
          to="/settings/$section"
          params={{ section: SettingsSectionKey.Integrations }}
        />
      )}
    >
      {label}
    </Button>
  );
}

/** Why Slack can't be used for this project now, in words; null when it can. */
function lackOf(off: boolean, workspace: string | null): string | null {
  if (off) return 'Slack is turned off in this copy of 10db.';
  if (workspace === null)
    return 'This project has no Slack workspace; choose one in Settings › Integrations.';
  return null;
}

/** Whether pictures are posted to Slack, and the channel: each change saves at once. */
function SlackPictures({ project }: { readonly project: ProjectDto }) {
  const status = useSlackStatus();
  const integrations = useProjectIntegrations(project.id);
  const sharing = useSlackSharing(project.id);
  const save = useSetSlackSharing(project.id);
  const workspace = integrations.data?.slack.teamName ?? null;
  const lack = status.data === undefined ? null : lackOf(status.data.off, workspace);
  const ready = status.data !== undefined && lack === null;
  const channels = useSlackChannels(project.id, ready);
  if (sharing.data === undefined || integrations.data === undefined || status.data === undefined)
    return <Skeleton height={120} radius="md" />;
  const current = sharing.data;
  const list = channels.data?.state === 'ok' ? channels.data.channels : [];
  const data = list.map((c) => ({ value: c.id, label: channelLabel(c) }));
  if (current.channelId !== null && !list.some((c) => c.id === current.channelId))
    data.push({ value: current.channelId, label: `#${current.channelName ?? current.channelId}` });
  const mutate = (patch: { enabled?: boolean; channel?: SlackChannelDto | null }) => {
    const channel = patch.channel === undefined ? undefined : patch.channel;
    save.mutate({
      enabled: patch.enabled ?? current.enabled,
      channelId: channel === undefined ? current.channelId : (channel?.id ?? null),
      channelName: channel === undefined ? current.channelName : (channel?.name ?? null),
    });
  };
  return (
    <SettingsCard
      title="Slack"
      action={lack === null ? null : <IntegrationsLink label="Open Integrations" />}
    >
      <SettingRow
        label="Post Pictures to Slack"
        description={
          lack ??
          'When a task that changes a page is done, or a UI Workbench pull request opens, @10db posts its before and after pictures.'
        }
        help="One message per finished task (its before and after pictures, up to 10 files) or per UI Workbench pull request (the signed-off pages and the pull request link). Everyone in the channel sees the pictures, data on the page included. Only tasks finished after this is turned on are posted."
      >
        <Group justify="flex-end">
          <Switch
            aria-label="Post Pictures to Slack"
            checked={current.enabled && lack === null}
            disabled={lack !== null || save.isPending}
            onChange={(event) => {
              mutate({ enabled: event.currentTarget.checked });
            }}
          />
        </Group>
      </SettingRow>
      <SettingRow
        label="Slack Channel"
        description={
          workspace === null
            ? 'The channel in the project’s workspace.'
            : `A channel in ${workspace}. @10db joins a public one; invite @10db to a private one first.`
        }
      >
        <Select
          aria-label="Slack Channel"
          placeholder={channels.isPending && ready ? 'Reading channels…' : 'Pick a channel'}
          searchable
          clearable
          data={data}
          disabled={lack !== null || channels.data?.state === 'missing_scope'}
          value={current.channelId}
          nothingFoundMessage="No channel found. A private channel shows once @10db is invited to it."
          error={
            channels.isError
              ? channels.error.message
              : current.enabled && lack === null && current.channelId === null
                ? 'Pick a channel, or nothing is posted.'
                : undefined
          }
          onChange={(id) => {
            mutate({ channel: list.find((c) => c.id === id) ?? null });
          }}
        />
      </SettingRow>
      {channels.data?.state === 'missing_scope' ? (
        <Alert color="yellow" title="The Slack app can't list channels yet" m="md">
          <Text size="sm">
            Add the channels:read, groups:read, channels:join and files:write scopes to the 10db
            Slack app, reinstall it to the workspace, then press Replace Token on the Slack card in
            Settings › Integrations.
          </Text>
        </Alert>
      ) : null}
      {save.isError ? (
        <Text size="sm" c="red" px="md" py="xs">
          {save.error.message}
        </Text>
      ) : null}
    </SettingsCard>
  );
}

/** Settings › This Project › Sharing: where a pass's pictures go once its pull request is open. */
export function ProjectSharing({ project }: { readonly project: ProjectDto }) {
  const fields = useProjectFields(project, ['prPictures']);
  const { values, set } = fields;
  return (
    <Stack gap="xl">
      <SettingsCard title="GitHub">
        <SettingRow
          label="Pictures in Pull Requests"
          description="Shows each signed-off page before and after."
          help="A UI Workbench pull request shows each signed-off page before and after. The pictures are pushed to a 10db-pictures branch on GitHub, so anyone who can see the repository can see them, data on the page included."
        >
          <Group justify="flex-end">
            <Switch
              aria-label="Pictures in Pull Requests"
              checked={values.prPictures}
              onChange={(e) => {
                set({ prPictures: e.currentTarget.checked });
              }}
            />
          </Group>
        </SettingRow>
      </SettingsCard>
      <SlackPictures project={project} />
      <ProjectSaveBar fields={fields} />
    </Stack>
  );
}
