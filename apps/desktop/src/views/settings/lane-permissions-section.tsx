import { Group, Switch } from '@mantine/core';
import { useLanePermissions, useSetLanePermissions } from '../../daemon/queries';
import { SettingRow, SettingsCard } from './setting-row';

const LABEL = "Lanes decide routine permissions with Claude Code's auto mode";

export function LanePermissionsSection() {
  const status = useLanePermissions();
  const set = useSetLanePermissions();
  return (
    <SettingsCard>
      <SettingRow
        label={LABEL}
        description="Plain commands, reads and builds run without a card. Dependency changes, background loops that never end, new network hosts for Claude Code's own tools, and reads outside the allowed paths still ask you. Applies from the next session."
      >
        <Group justify="flex-end">
          <Switch
            aria-label={LABEL}
            checked={status.data?.autoMode ?? false}
            disabled={status.data === undefined}
            onChange={(e) => {
              set.mutate(e.currentTarget.checked);
            }}
          />
        </Group>
      </SettingRow>
    </SettingsCard>
  );
}
