import { KeepAwakeMode } from '@10db/contracts';
import { Radio, Stack, Text } from '@mantine/core';
import { useKeepAwake, useSetKeepAwake } from '../../daemon/queries';
import { MODE_LABELS } from '../../shell/keep-awake-labels';

const MODES: readonly KeepAwakeMode[] = Object.values(KeepAwakeMode);

function isMode(value: string): value is KeepAwakeMode {
  return MODES.some((m) => m === value);
}

export function KeepAwakeSection() {
  const status = useKeepAwake();
  const setMode = useSetKeepAwake();
  return (
    <Stack>
      <Radio.Group
        label="Keep the Mac awake"
        value={status.data?.mode ?? null}
        onChange={(value) => {
          if (isMode(value)) setMode.mutate(value);
        }}
      >
        <Stack gap="xs" mt="xs">
          {MODES.map((mode) => (
            <Radio key={mode} value={mode} label={MODE_LABELS[mode]} />
          ))}
        </Stack>
      </Radio.Group>
      <Text size="sm" c="dimmed">
        {status.data?.active ? 'Keeping the Mac awake now.' : 'Not keeping the Mac awake now.'}
      </Text>
    </Stack>
  );
}
