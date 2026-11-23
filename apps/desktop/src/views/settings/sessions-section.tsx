import { TerminalApp, TerminalAppSchema } from '@10db/contracts';
import { Group, Select, Switch } from '@mantine/core';
import {
  useSessionsSettings,
  useSetSessionsSettings,
} from '../../daemon/sessions-settings-queries';
import { HelpText } from './help-hint';
import { SettingRow, SettingsCard } from './setting-row';

const TERMINAL_CHOICES: readonly { readonly value: TerminalApp; readonly label: string }[] = [
  { value: TerminalApp.Terminal, label: 'Terminal' },
  { value: TerminalApp.ITerm, label: 'iTerm' },
  { value: TerminalApp.Copy, label: 'Copy the Command' },
];

export function SessionsSection() {
  const settings = useSessionsSettings();
  const set = useSetSessionsSettings();
  return (
    <SettingsCard>
      <SettingRow
        label="Notify When a Chat Replies"
        description="A notification with the reply's first line, while 10db is behind another app."
      >
        <Group justify="flex-end">
          <Switch
            aria-label="Notify When a Chat Replies"
            checked={settings.data?.notifyReplies ?? true}
            disabled={settings.data === undefined}
            onChange={(event) => {
              set.mutate({ notifyReplies: event.currentTarget.checked });
            }}
          />
        </Group>
      </SettingRow>
      <SettingRow
        label="Open Sessions In"
        description="Where Open in Terminal continues a chat."
        help={
          <HelpText>
            Terminal and iTerm continue a chat in that app. Copy the Command opens nothing and gives
            you a line for zsh or bash, to paste into any terminal, such as Ghostty, Warp or kitty.
          </HelpText>
        }
      >
        <Select
          aria-label="Open Sessions In"
          data={TERMINAL_CHOICES.map((choice) => ({ ...choice }))}
          value={settings.data?.terminalApp ?? TerminalApp.Terminal}
          disabled={settings.data === undefined}
          allowDeselect={false}
          checkIconPosition="right"
          onChange={(value) => {
            const app = TerminalAppSchema.safeParse(value);
            if (app.success) set.mutate({ terminalApp: app.data });
          }}
        />
      </SettingRow>
    </SettingsCard>
  );
}
