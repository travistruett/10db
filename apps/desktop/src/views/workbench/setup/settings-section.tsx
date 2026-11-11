import { SettingField, type SettingSuggestion } from '@10db/contracts';
import { Checkbox, Code, Stack, Text, Title } from '@mantine/core';

/** Each suggested setting by the name Settings gives it. */
export const SETTING_LABELS: Readonly<Record<SettingField, string>> = {
  [SettingField.AppUrl]: 'App address',
  [SettingField.DevLoginCommand]: 'Sign-in for pictures',
  [SettingField.ChangedCheckCommand]: 'Check after each turn',
  [SettingField.SandboxDocker]: 'Allow Docker',
};

export interface SettingsSectionProps {
  readonly settings: readonly SettingSuggestion[];
  readonly ticked: readonly SettingField[];
  readonly onTick: (field: SettingField, ticked: boolean) => void;
}

/** The setup's Settings: one row per suggestion, its value and where it was found. */
export function SettingsSection({ settings, ticked, onTick }: SettingsSectionProps) {
  return (
    <Stack gap="sm" component="section" aria-label="Settings">
      <Title order={3}>Settings</Title>
      {settings.map((setting) => (
        <Checkbox
          key={setting.field}
          checked={ticked.includes(setting.field)}
          onChange={(event) => {
            onTick(setting.field, event.currentTarget.checked);
          }}
          label={
            <>
              {`${SETTING_LABELS[setting.field]}: `}
              <Code style={{ overflowWrap: 'anywhere' }}>
                {setting.field === SettingField.SandboxDocker ? 'on' : setting.value}
              </Code>
            </>
          }
          description={
            <>
              <Text component="span" size="xs">
                {setting.source}
              </Text>
              {setting.note === undefined ? null : (
                <Text component="span" size="xs" display="block">
                  {setting.note}
                </Text>
              )}
            </>
          }
        />
      ))}
    </Stack>
  );
}
