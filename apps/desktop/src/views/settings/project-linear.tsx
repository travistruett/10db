import type { ProjectDto } from '@10db/contracts';
import { Button, Group, Switch, Text, Textarea } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useProjectIntegrations, useSetLinearReporter } from '../../daemon/sign-in-queries';
import { SettingsSectionKey } from './sections';
import { useDraft } from './settings-drafts';
import { SettingRow, SettingsCard } from './setting-row';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';

/**
 * Settings › This Project › Linear: whether a task made from a Linear issue keeps the issue updated, and the
 * note the agent that updates it follows, both saved with the page's bar. The same switch is the
 * project's row on Integrations.
 */
export function ProjectLinear({ project }: { readonly project: ProjectDto }) {
  const integrations = useProjectIntegrations(project.id);
  const save = useSetLinearReporter(project.id);
  const saved = integrations.data?.linear;
  const draft = useDraft({
    saved: saved === undefined ? undefined : { on: saved.on, note: saved.note },
    save: (value) => save.mutateAsync(value),
  });
  if (integrations.isError)
    return (
      <Text size="sm" c="red">
        Couldn't read this project's Linear settings: {integrations.error.message}
      </Text>
    );
  const linear = integrations.data?.linear;
  const value = draft.value;
  if (linear === undefined || value === undefined)
    return (
      <PageLoading shape={PageLoadingShape.Cards} rows={1} label="Reading the Linear settings" />
    );
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
            checked={value.on}
            onChange={(event) => {
              draft.set({ ...value, on: event.currentTarget.checked });
            }}
          />
        </Group>
      </SettingRow>
      {linear.blockedBy === null || !value.on ? null : (
        <Text size="xs" c="dimmed">
          {linear.blockedBy}
        </Text>
      )}
      <SettingRow
        label="Update Note"
        description="How the updates should read."
        help="Without a note the agent never sets a done status; say so here if it should."
        stacked
      >
        <Textarea
          aria-label="Update Note"
          autosize
          minRows={2}
          placeholder="Optional: e.g. move the issue to Done when the pull request merges"
          value={value.note}
          onChange={(event) => {
            draft.set({ ...value, note: event.currentTarget.value });
          }}
        />
      </SettingRow>
    </SettingsCard>
  );
}
