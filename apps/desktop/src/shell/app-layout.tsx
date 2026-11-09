import { AppShell, Badge, Divider, Group, NavLink, VisuallyHidden } from '@mantine/core';
import {
  IconBulb,
  IconBuildingFactory2,
  IconInbox,
  IconLayoutKanban,
  IconRoute,
  IconSettings,
} from '@tabler/icons-react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useDaemonStatus } from '../daemon/provider';
import { useDesktopSync } from '../desktop/sync';
import { useRenderMode } from '../screens/render-context';
import { RenderLayout } from '../screens/render-layout';
import { ScreenRenderHost } from '../screens/screen-render-host';
import { AgentDownloadStatus } from './agent-download-status';
import { BuildCommit } from './build-commit';
import { ColorSchemeToggle } from './color-scheme-toggle';
import { DaemonStatus } from './daemon-status';
import { KeepAwakeControl } from './keep-awake-control';
import { ProjectSwitcher } from './project-switcher';
import { useOpenInboxCount } from '../views/inbox/inbox-count';
import { FirstRun } from '../views/first-run/first-run';
import { SettingsNav } from '../views/settings/settings-nav';
import { ReconnectingBanner } from './reconnecting-banner';
import { useSelectedProject } from './selected-project';
import { ShapeNav } from './shape-nav';

const NAV = [
  { to: '/board', label: 'Board', icon: IconLayoutKanban },
  { to: '/factory', label: 'Factory', icon: IconBuildingFactory2 },
  { to: '/shape', label: 'Plan', icon: IconRoute },
  { to: '/inbox', label: 'Inbox', icon: IconInbox },
  { to: '/knowledge', label: 'Knowledge', icon: IconBulb },
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

/** The shell, or in a frame the window draws a screen in (Shape spec §5.5), the screen alone. */
export function AppLayout() {
  return useRenderMode() === null ? <FullLayout /> : <RenderLayout />;
}

function FullLayout() {
  useDesktopSync();
  const status = useDaemonStatus();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/');
  const openCards = useOpenInboxCount();
  const { projects, select } = useSelectedProject();
  const navigate = useNavigate();
  // The first run replaces the shell only once the list has loaded empty on a live connection; while
  // it loads, or the daemon connects or reconnects, the shell shows and its banners say why.
  if (status.kind === 'connected' && projects.isSuccess && projects.data.length === 0) {
    return (
      <FirstRun
        onCreated={(project) => {
          select(project.id);
          void navigate({ to: '/board' });
        }}
      />
    );
  }
  return (
    <AppShell header={{ height: 48 }} navbar={{ width: 200, breakpoint: 'sm' }} padding="md">
      {/* The window has no title bar: macOS draws its traffic lights over the header's left end, and
          the header's empty space drags the window. */}
      <AppShell.Header data-tauri-drag-region>
        <Group h="100%" px="md" gap="sm" justify="flex-end" data-tauri-drag-region>
          <AgentDownloadStatus />
          <BuildCommit />
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
            {NAV.map(({ to, label, icon: Icon }) =>
              to === '/shape' ? (
                <ShapeNav key={to} pathname={pathname} />
              ) : (
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
              ),
            )}
          </>
        )}
      </AppShell.Navbar>
      {/* A column, so a view can take the height the reconnecting banner leaves rather than assume it.
          Nothing else goes above a view: what needs the builder is a card in the Inbox. */}
      <AppShell.Main style={{ display: 'flex', flexDirection: 'column' }}>
        {status.kind === 'connected' && <ScreenRenderHost />}
        {status.kind === 'reconnecting' && <ReconnectingBanner since={status.since} />}
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
