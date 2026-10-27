import { AppShell, Badge, Group, NavLink, VisuallyHidden } from '@mantine/core';
import {
  IconBuildingFactory2,
  IconInbox,
  IconLayoutKanban,
  IconSettings,
} from '@tabler/icons-react';
import { Link, Outlet } from '@tanstack/react-router';
import { useDaemonStatus } from '../daemon/provider';
import { useInbox } from '../daemon/queries';
import { useDesktopSync } from '../desktop/sync';
import { ColorSchemeToggle } from './color-scheme-toggle';
import { DaemonStatus } from './daemon-status';
import { KeepAwakeControl } from './keep-awake-control';
import { ReconnectingBanner } from './reconnecting-banner';
import { SystemAlert } from './system-alert';

const NAV = [
  { to: '/board', label: 'Board', icon: IconLayoutKanban },
  { to: '/factory', label: 'Factory', icon: IconBuildingFactory2 },
  { to: '/inbox', label: 'Inbox', icon: IconInbox },
  { to: '/settings', label: 'Settings', icon: IconSettings },
] as const;

function InboxBadge({ count }: { readonly count: number }) {
  return (
    <Badge size="sm" circle>
      {/* The name computation drops a leading space inside VisuallyHidden, so the number is hidden
          from assistive tech and the hidden text carries the whole phrase. */}
      <span aria-hidden="true">{count}</span>
      <VisuallyHidden>{`${String(count)} open card${count === 1 ? '' : 's'}`}</VisuallyHidden>
    </Badge>
  );
}

export function AppLayout() {
  useDesktopSync();
  const status = useDaemonStatus();
  const openCards = useInbox().data?.length ?? 0;
  return (
    <AppShell header={{ height: 48 }} navbar={{ width: 200, breakpoint: 'sm' }} padding="md">
      {/* The window has no title bar: macOS draws its traffic lights over the header's left end, and
          the header's empty space drags the window. */}
      <AppShell.Header data-tauri-drag-region>
        <Group h="100%" px="md" gap="sm" justify="flex-end" data-tauri-drag-region>
          <DaemonStatus />
          <KeepAwakeControl />
          <ColorSchemeToggle />
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            component={Link}
            to={to}
            label={label}
            leftSection={<Icon size={16} stroke={1.5} />}
            rightSection={
              to === '/inbox' && openCards > 0 ? <InboxBadge count={openCards} /> : undefined
            }
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main>
        {status.kind === 'reconnecting' && <ReconnectingBanner since={status.since} />}
        <SystemAlert />
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
