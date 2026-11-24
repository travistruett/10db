import type { ProjectDto } from '@10db/contracts';
import { Group, Stack, Switch, Textarea } from '@mantine/core';
import { NetworkHostsSection } from './network-hosts-section';
import { MONO_INPUT, useProjectFields } from './project-fields-state';
import { HiddenFieldAlert } from './hidden-field-alert';
import { SettingRow, SettingsCard } from './setting-row';

/**
 * What a project's tasks and checks may do inside the sandbox: the permissions saved with the bar, then
 * the hosts they may reach, which save as each is added or removed.
 */
export function SandboxSection({ project }: { readonly project: ProjectDto }) {
  const fields = useProjectFields(project, ['sandboxLoopback', 'sandboxDocker', 'allowedCommands']);
  const { values, errors, set } = fields;
  return (
    <Stack gap="xl">
      <SettingsCard title="Permissions">
        <SettingRow
          label="Allow localhost"
          description="For dev servers and tests that start a local server."
          help="Tasks can then reach every port on this Mac, not just this project's: other projects' databases and dev servers, and local apps. A server a task starts on 0.0.0.0 can be reached from your network. With Docker on, a container can already reach these ports."
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
          help="A container can mount any folder on this Mac and reach every local port, so a gate or task with Docker can reach outside the sandbox, past Allow localhost too."
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
          label="Allowed Commands"
          description="One per line, such as pnpm test."
          help="Tasks run these without asking you; 10db still checks each one."
          stacked
        >
          <Textarea
            aria-label="Allowed Commands"
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

      <HiddenFieldAlert fields={fields} />
    </Stack>
  );
}
