import { SegmentedControl, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { SettingRow, SettingsCard } from './setting-row';

const SCHEMES = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
] as const;

/** The app's theme, dark by default; the window's own chrome follows it. */
export function AppearanceSection() {
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('dark');
  return (
    <SettingsCard>
      <SettingRow label="Theme" description="The window's title bar follows it too.">
        <SegmentedControl
          aria-label="Theme"
          fullWidth
          value={scheme}
          data={[...SCHEMES]}
          onChange={setColorScheme}
        />
      </SettingRow>
    </SettingsCard>
  );
}
