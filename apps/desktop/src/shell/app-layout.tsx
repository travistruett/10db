import { AppShell, Badge, Divider, Group, NavLink, VisuallyHidden } from '@mantine/core';
import {
  IconBuildingFactory2,
  IconInbox,
  IconLayoutKanban,
  IconSettings,
} from '@tabler/icons-react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useDaemonStatus } from '../daemon/provider';
import { useInbox } from '../daemon/queries';
import { useDesktopSync } from '../desktop/sync';
import { ColorSchemeToggle } from './color-scheme-toggle';
import { DaemonStatus } from './daemon-status';
import { KeepAwakeControl } from './keep-awake-control';
import { ProjectSwitcher } from './project-switcher';
import { SettingsNav } from '../views/settings/settings-nav';
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
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/');
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
      {/* The sidebar sits a Selenized step above the content, so the fills that would match the body
          (active and hover states, the dark/gray scale steps) move up one step inside it. */}
      <AppShell.Navbar
        p="xs"
        bg="var(--mantine-color-default)"
        style={{
          '--mantine-primary-color-light': 'var(--mantine-color-default-hover)',
          '--mantine-primary-color-light-color': 'var(--mantine-color-bright)',
          '--mantine-color-dark-6': 'var(--mantine-color-default-hover)',
          '--mantine-color-gray-0': 'var(--mantine-color-default-hover)',
        }}
      >
        {inSettings ? (
          <SettingsNav />
        ) : (
          <>
            <ProjectSwitcher />
            <Divider my="xs" />
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                component={Link}
                to={to}
                active={pathname === to || pathname.startsWith(`${to}/`)}
                label={label}
                leftSection={<Icon size={16} stroke={1.5} />}
                rightSection={
                  to === '/inbox' && openCards > 0 ? <InboxBadge count={openCards} /> : undefined
                }
              />
            ))}
          </>
        )}
      </AppShell.Navbar>
      <AppShell.Main>
        {status.kind === 'reconnecting' && <ReconnectingBanner since={status.since} />}
        <SystemAlert />
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
