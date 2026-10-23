import { KeepAwakeMode } from '@10db/contracts';
import { ActionIcon, Menu } from '@mantine/core';
import { IconCheck, IconCoffee, IconCoffeeOff } from '@tabler/icons-react';
import { useKeepAwake, useSetKeepAwake } from '../daemon/queries';
import { MODE_LABELS } from './keep-awake-labels';

export function KeepAwakeControl() {
  const status = useKeepAwake();
  const setMode = useSetKeepAwake();
  const active = status.data?.active ?? false;
  const label = active ? 'Keeping the Mac awake' : 'Not keeping the Mac awake';
  return (
    <Menu position="bottom-end">
      <Menu.Target>
        <ActionIcon variant="subtle" aria-label={`Keep-awake: ${label}`} title={label}>
          {active ? (
            <IconCoffee size={18} stroke={1.5} />
          ) : (
            <IconCoffeeOff size={18} stroke={1.5} />
          )}
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Keep the Mac awake</Menu.Label>
        {Object.values(KeepAwakeMode).map((mode) => (
          <Menu.Item
            key={mode}
            leftSection={
              status.data?.mode === mode ? (
                <IconCheck size={14} stroke={1.5} />
              ) : (
                <span style={{ width: 14 }} />
              )
            }
            onClick={() => {
              setMode.mutate(mode);
            }}
          >
            {MODE_LABELS[mode]}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
