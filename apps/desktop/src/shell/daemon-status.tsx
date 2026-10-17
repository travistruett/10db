import { Badge } from '@mantine/core';
import { useDaemonStatus } from '../daemon/provider';

export function DaemonStatus() {
  const status = useDaemonStatus();
  switch (status.kind) {
    case 'connected':
      return <Badge color="teal">Daemon connected</Badge>;
    case 'reconnecting':
      return <Badge color="yellow">Reconnecting…</Badge>;
    case 'mismatch':
      return <Badge color="red">Version mismatch</Badge>;
    case 'connecting':
      return <Badge color="gray">Connecting…</Badge>;
  }
}
