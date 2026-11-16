import { TerminalApp, TerminalAppSchema } from '@10db/contracts';
import { SegmentedControl, Switch } from '@mantine/core';
import {
  useSessionsSettings,
  useSetSessionsSettings,
} from '../../daemon/sessions-settings-queries';
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
        label="Notify when a chat replies"
        description="While 10db is behind another app, a chat's reply raises a notification with its first line."
      >
        <Switch
          aria-label="Notify when a chat replies"
          checked={settings.data?.notifyReplies ?? true}
          disabled={settings.data === undefined}
          onChange={(event) => {
            set.mutate({ notifyReplies: event.currentTarget.checked });
          }}
        />
      </SettingRow>
      <SettingRow
        label="Open sessions in"
        description="Open in Terminal continues a chat in this app. Copy the Command opens nothing and gives you a line for zsh or bash, to paste into any terminal, such as Ghostty, Warp or kitty."
      >
        <SegmentedControl
          aria-label="Open sessions in"
          data={TERMINAL_CHOICES.map((choice) => ({ ...choice }))}
          value={settings.data?.terminalApp ?? TerminalApp.Terminal}
          disabled={settings.data === undefined}
          onChange={(value) => {
            const app = TerminalAppSchema.safeParse(value);
            if (app.success) set.mutate({ terminalApp: app.data });
          }}
        />
      </SettingRow>
    </SettingsCard>
  );
}
