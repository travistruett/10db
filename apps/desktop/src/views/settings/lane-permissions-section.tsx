import { Badge, Group, Stack, Switch } from '@mantine/core';
import { useLanePermissions, useSetLanePermissions } from '../../daemon/queries';
import { HelpText } from './help-hint';
import { SettingRow, SettingsCard } from './setting-row';
import { SectionHeading } from './section-heading';

const LABEL = 'Approve Routine Calls Automatically';

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
      <SettingsCard>
        <SettingRow
          label={LABEL}
          description={
            on
              ? 'Routine commands, reads and builds run without asking you.'
              : "Off: 10db's fixed rules decide, and anything they can't settle comes to you."
          }
          help={
            <Stack gap={6}>
              <HelpText>Claude models: Claude Code's auto mode approves.</HelpText>
              <HelpText>
                Codex and older models: 10db's judge approves (Settings › Decisions).
              </HelpText>
              <HelpText>Still Asks You always comes to you.</HelpText>
            </Stack>
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
        <SectionHeading
          title="Still Asks You"
          line="Even with this on, these come to your Inbox."
        />
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
