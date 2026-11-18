import { Box } from '@mantine/core';
import { IconAlertTriangle, IconPlayerPause, IconTerminal2 } from '@tabler/icons-react';
import type { TabWords } from './tab-state';

/** The state mark at the tab's right: a dot or a glyph, each with a shape of its own. */
export function Mark({ mark }: { readonly mark: TabWords['mark'] }) {
  switch (mark) {
    case 'dot_blue':
    case 'dot_yellow':
      return (
        <Box
          data-mark={mark}
          w={8}
          h={8}
          style={{
            borderRadius: '50%',
            background:
              mark === 'dot_blue'
                ? 'var(--mantine-color-blue-filled)'
                : 'var(--mantine-color-yellow-filled)',
          }}
        />
      );
    case 'alert_red':
      return (
        <IconAlertTriangle
          data-mark={mark}
          size={12}
          stroke={1.5}
          color="var(--mantine-color-red-filled)"
        />
      );
    case 'pause_orange':
      return (
        <IconPlayerPause
          data-mark={mark}
          size={12}
          stroke={1.5}
          color="var(--mantine-color-orange-filled)"
        />
      );
    case 'terminal_dim':
      return (
        <IconTerminal2
          data-mark={mark}
          size={12}
          stroke={1.5}
          color="var(--mantine-color-dimmed)"
        />
      );
    case null:
      return null;
  }
}
