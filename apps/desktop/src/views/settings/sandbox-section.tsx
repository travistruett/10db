import type { ProjectDto } from '@10db/contracts';
import { Group, Stack, Switch, Textarea } from '@mantine/core';
import { SaveBar } from '../../shell/save-bar';
import { NetworkHostsSection } from './network-hosts-section';
import { MONO_INPUT, useProjectFields } from './project-fields-state';
import { SettingRow, SettingsCard } from './setting-row';

/**
 * What a project's tasks and checks may do inside the sandbox: the permissions saved with the bar, then
 * the hosts they may reach, which save as each is added or removed.
 */
export function SandboxSection({ project }: { readonly project: ProjectDto }) {
  const { values, errors, note, set, save, reset, saving, saveError } = useProjectFields(project);
  return (
    <Stack gap="xl">
      <SettingsCard title="Permissions">
        <SettingRow
          label="Allow localhost"
          description="For tests that start a local server."
          help="Opens every local port to tasks, not just this project's."
        >
          <Group justify="flex-end">
            <Switch
              aria-label="Allow localhost"
              checked={values.sandboxLoopback}
              onChange={(e) => {
                set({ sandboxLoopback: e.currentTarget.checked });
              }}
            />
          </Group>
        </SettingRow>
        <SettingRow
          label="Allow Docker"
          description="For gates and tasks that run docker compose."
          help="Docker can mount any host folder into a container, so a gate or task with Docker can reach outside the sandbox."
        >
          <Group justify="flex-end">
            <Switch
              aria-label="Allow Docker"
              checked={values.sandboxDocker}
              onChange={(e) => {
                set({ sandboxDocker: e.currentTarget.checked });
              }}
            />
          </Group>
        </SettingRow>
        <SettingRow
          label="Commands That Don't Ask"
          description="One per line, such as pnpm test."
          help="Tasks run these without asking you; 10db still checks each one."
          stacked
        >
          <Textarea
            aria-label="Commands That Don't Ask"
            styles={MONO_INPUT}
            autosize
            minRows={1}
            maxRows={10}
            value={values.allowedCommands}
            error={errors.allowedCommands}
            onChange={(e) => {
              set({ allowedCommands: e.currentTarget.value });
            }}
          />
        </SettingRow>
      </SettingsCard>

      <NetworkHostsSection project={project} />

      <SaveBar error={saveError} note={note} saving={saving} onReset={reset} onSave={save} />
    </Stack>
  );
}
