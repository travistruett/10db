import type { ProjectDto } from '@10db/contracts';
import { Button, Group, Skeleton, Switch, Text, Textarea } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useProjectIntegrations, useSetLinearReporter } from '../../daemon/sign-in-queries';
import { SettingsSectionKey } from './sections';
import { SettingRow, SettingsCard } from './setting-row';

/**
 * Settings › This Project › Linear: whether a task made from a Linear issue keeps the issue updated, and the
 * note the agent that updates it follows. The same switch is the project's row on Integrations.
 */
export function ProjectLinear({ project }: { readonly project: ProjectDto }) {
  const integrations = useProjectIntegrations(project.id);
  const save = useSetLinearReporter(project.id);
  if (integrations.isError)
    return (
      <Text size="sm" c="red">
        Couldn't read this project's Linear settings: {integrations.error.message}
      </Text>
    );
  const linear = integrations.data?.linear;
  if (linear === undefined) return <Skeleton height={160} radius="md" />;
  return (
    <SettingsCard
      title="Issue Updates"
      action={
        <Button
          variant="default"
          size="compact-sm"
          renderRoot={(props) => (
            <Link
              {...props}
              to="/settings/$section"
              params={{ section: SettingsSectionKey.Integrations }}
              search={{ focus: 'linear' }}
            />
          )}
        >
          Open Integrations
        </Button>
      }
    >
      <SettingRow
        label="Keep Issues Updated"
        description="A task made from a Linear issue comments on it and moves its status."
        help="The project's agent account signs in to Linear; Connect Linear on Settings › Integrations sets that up."
      >
        <Group justify="flex-end">
          <Switch
            aria-label="Keep Issues Updated"
            checked={linear.on}
            disabled={save.isPending}
            onChange={(event) => {
              save.mutate({ on: event.currentTarget.checked, note: linear.note });
            }}
          />
        </Group>
      </SettingRow>
      {linear.blockedBy === null || !linear.on ? null : (
        <Text size="xs" c="dimmed">
          {linear.blockedBy}
        </Text>
      )}
      <SettingRow
        label="Update Note"
        description="How the updates should read. Saved when you leave the field."
        help="Without a note the agent never sets a done status; say so here if it should."
        stacked
      >
        <Textarea
          // Keyed by the saved note, so a save from elsewhere replaces what the field shows.
          key={linear.note}
          aria-label="Update Note"
          autosize
          minRows={2}
          placeholder="Optional: e.g. move the issue to Done when the pull request merges"
          defaultValue={linear.note}
          onBlur={(event) => {
            const note = event.currentTarget.value;
            if (note !== linear.note) save.mutate({ on: linear.on, note });
          }}
        />
      </SettingRow>
      {save.isError ? (
        <Text size="xs" c="red">
          {save.error.message}
        </Text>
      ) : null}
    </SettingsCard>
  );
}
