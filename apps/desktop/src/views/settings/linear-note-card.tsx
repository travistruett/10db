import type { ProjectDto } from '@10db/contracts';
import { Text, Textarea } from '@mantine/core';
import { useProjectIntegrations, useSetLinearReporter } from '../../daemon/sign-in-queries';
import { SettingRow, SettingsCard } from './setting-row';

/** The note the agent that updates a project's Linear issues follows; saved when the field loses focus. */
export function LinearNoteCard({ project }: { readonly project: ProjectDto }) {
  const integrations = useProjectIntegrations(project.id);
  const save = useSetLinearReporter(project.id);
  const linear = integrations.data?.linear;
  if (linear === undefined) return null;
  return (
    <SettingsCard title="Linear">
      <SettingRow
        label="Update Note"
        description="How a task from a Linear issue reports to it."
        help="The agent that comments on the issue and moves its status reads this. Without a note it never sets a done status; say so here if it should. Linear is turned on per project in Settings › Integrations."
        stacked
      >
        <Textarea
          // Keyed by the saved note, so a save from elsewhere replaces what the field shows.
          key={linear.note}
          aria-label="Linear Update Note"
          autosize
          minRows={2}
          placeholder="Optional: e.g. move the issue to Done when the pull request merges"
          defaultValue={linear.note}
          onBlur={(event) => {
            const note = event.currentTarget.value;
            if (note !== linear.note) save.mutate({ on: linear.on, note });
          }}
        />
        {save.isError ? (
          <Text size="xs" c="red">
            {save.error.message}
          </Text>
        ) : null}
      </SettingRow>
    </SettingsCard>
  );
}
