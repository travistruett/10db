import { Switch } from '@mantine/core';
import {
  useSessionsSettings,
  useSetSessionsSettings,
} from '../../daemon/sessions-settings-queries';
import { SettingRow, SettingsCard } from './setting-row';

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
    </SettingsCard>
  );
}
