import { ThemeIcon, Tooltip } from '@mantine/core';
import { IconPlugConnectedX, IconPlugX, type Icon } from '@tabler/icons-react';
import { useDaemonStatus } from '../daemon/provider';

function StatusIcon({
  label,
  color,
  icon: StatusGlyph,
}: {
  readonly label: string;
  readonly color: string;
  readonly icon: Icon;
}) {
  return (
    <Tooltip label={label}>
      <ThemeIcon variant="transparent" color={color} role="img" aria-label={label}>
        <StatusGlyph size={18} stroke={1.5} />
      </ThemeIcon>
    </Tooltip>
  );
}

/** Nothing while connected; a small icon in the header only when something is wrong. */
export function DaemonStatus() {
  const status = useDaemonStatus();
  switch (status.kind) {
    case 'connected':
      return null;
    case 'reconnecting':
      return (
        <StatusIcon label="Reconnecting to the daemon" color="yellow" icon={IconPlugConnectedX} />
      );
    case 'mismatch':
      return <StatusIcon label="Daemon version mismatch" color="red" icon={IconPlugX} />;
    case 'connecting':
      return <StatusIcon label="Connecting to the daemon" color="gray" icon={IconPlugConnectedX} />;
  }
}
