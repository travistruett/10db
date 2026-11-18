import { ActionIcon, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { IconMoon, IconSun } from '@tabler/icons-react';
import { useRailMode } from './rail-mode';

export function ColorSchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('dark');
  const { labels } = useRailMode();
  const next = scheme === 'dark' ? 'light' : 'dark';
  return (
    <Tooltip label={`Switch to ${next} mode`} position="right">
      <ActionIcon
        variant="subtle"
        color="gray"
        w={labels ? 28 : 40}
        h={labels ? 28 : 34}
        aria-label={`Switch to ${next} mode`}
        onClick={() => {
          setColorScheme(next);
        }}
      >
        {scheme === 'dark' ? (
          <IconSun size={18} stroke={1.6} />
        ) : (
          <IconMoon size={18} stroke={1.6} />
        )}
      </ActionIcon>
    </Tooltip>
  );
}
