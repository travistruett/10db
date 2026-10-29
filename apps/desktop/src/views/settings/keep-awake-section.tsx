import { KeepAwakeMode } from '@10db/contracts';
import { SegmentedControl } from '@mantine/core';
import { useKeepAwake, useSetKeepAwake } from '../../daemon/queries';
import { SettingRow, SettingsCard } from './setting-row';

const MODES: readonly KeepAwakeMode[] = Object.values(KeepAwakeMode);

function isMode(value: string): value is KeepAwakeMode {
  return MODES.some((m) => m === value);
}

/** Short labels for the segmented control; the menu in the header spells each out. */
const SHORT_LABEL: Readonly<Record<KeepAwakeMode, string>> = {
  [KeepAwakeMode.Off]: 'Never',
  [KeepAwakeMode.WhileRunning]: 'While tasks run',
  [KeepAwakeMode.Always]: 'Always',
};

export function KeepAwakeSection() {
  const status = useKeepAwake();
  const setMode = useSetKeepAwake();
  return (
    <SettingsCard>
      <SettingRow
        label="Keep the Mac awake"
        description={
          status.data?.active ? 'Keeping the Mac awake now.' : 'Not keeping the Mac awake now.'
        }
      >
        <SegmentedControl
          aria-label="Keep the Mac awake"
          fullWidth
          value={status.data?.mode ?? ''}
          data={MODES.map((mode) => ({ value: mode, label: SHORT_LABEL[mode] }))}
          onChange={(value) => {
            if (isMode(value)) setMode.mutate(value);
          }}
        />
      </SettingRow>
    </SettingsCard>
  );
}
