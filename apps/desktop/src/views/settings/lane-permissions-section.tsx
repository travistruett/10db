import { Badge, Group, Stack, Switch, Text, Title } from '@mantine/core';
import { useLanePermissions, useSetLanePermissions } from '../../daemon/queries';
import { HelpText } from './help-hint';
import { SettingRow, SettingsCard } from './setting-row';

const LABEL = "Use Claude Code's Auto Mode";

/** What still comes to the builder as a card with auto mode on: the consequences a lane never decides alone. */
const STILL_ASKS: readonly string[] = [
  'Dependency changes',
  'Background loops that never end',
  "New network hosts for Claude Code's tools",
  'Reads outside the allowed paths',
];

/** Settings › Lane Permissions: whether a lane's routine permission prompts are decided for it, and what still asks. */
export function LanePermissionsSection() {
  const status = useLanePermissions();
  const set = useSetLanePermissions();
  const on = status.data?.autoMode ?? false;
  return (
    <Stack gap="xl">
      <Text size="sm" c="dimmed">
        How a lane's agent gets permission to run commands. Applies from the next session.
      </Text>
      <SettingsCard>
        <SettingRow
          label={LABEL}
          description={
            on
              ? 'Routine commands, reads and builds run without asking you.'
              : "Off: lanes use Claude Code's default permission mode."
          }
          help={
            <HelpText>
              Claude Code's auto mode decides each routine call in a lane, so plain commands, reads
              and builds run without a card. The calls listed under Still Asks You come to you.
            </HelpText>
          }
        >
          <Group justify="flex-end">
            <Switch
              aria-label={LABEL}
              checked={on}
              disabled={status.data === undefined}
              onChange={(e) => {
                set.mutate(e.currentTarget.checked);
              }}
            />
          </Group>
        </SettingRow>
      </SettingsCard>
      <Stack gap="xs">
        <Stack gap={2}>
          <Title order={4}>Still Asks You</Title>
          <Text size="xs" c="dimmed">
            With auto mode on, these still come to your Inbox.
          </Text>
        </Stack>
        <Group gap="xs">
          {STILL_ASKS.map((item) => (
            <Badge
              key={item}
              variant="default"
              tt="none"
              fw={400}
              size="lg"
              style={{ minWidth: 'max-content' }}
              styles={{ label: { overflow: 'visible', textOverflow: 'clip' } }}
            >
              {item}
            </Badge>
          ))}
        </Group>
      </Stack>
    </Stack>
  );
}
