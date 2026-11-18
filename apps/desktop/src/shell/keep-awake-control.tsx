import { KeepAwakeMode } from '@10db/contracts';
import { ActionIcon, Menu, Tooltip } from '@mantine/core';
import { IconCheck, IconCoffee, IconCoffeeOff } from '@tabler/icons-react';
import { useKeepAwake, useSetKeepAwake } from '../daemon/queries';
import { MODE_LABELS } from './keep-awake-labels';

export function KeepAwakeControl() {
  const status = useKeepAwake();
  const setMode = useSetKeepAwake();
  const active = status.data?.active ?? false;
  const label = active ? 'Keeping the Mac awake' : 'Not keeping the Mac awake';
  return (
    <Menu position="right-end">
      <Tooltip label={label} position="right" openDelay={300}>
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            w={36}
            h={34}
            aria-label={`Keep-awake: ${label}`}
          >
            {active ? (
              <IconCoffee size={18} stroke={1.6} />
            ) : (
              <IconCoffeeOff size={18} stroke={1.6} />
            )}
          </ActionIcon>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown>
        {Object.values(KeepAwakeMode).map((mode) => (
          <Menu.Item
            key={mode}
            rightSection={status.data?.mode === mode ? <IconCheck size={14} stroke={1.5} /> : null}
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
