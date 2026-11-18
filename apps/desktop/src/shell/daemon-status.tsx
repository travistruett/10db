import { Tooltip } from '@mantine/core';
import { IconPlugConnectedX, IconPlugX, type Icon } from '@tabler/icons-react';
import { useDaemonStatus } from '../daemon/provider';
import classes from './rail.module.css';

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
    <Tooltip label={label} position="right">
      <span
        className={classes['status']}
        role="img"
        aria-label={label}
        style={{ color: `var(--mantine-color-${color}-text)`, cursor: 'default' }}
      >
        <StatusGlyph size={18} stroke={1.5} />
      </span>
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
