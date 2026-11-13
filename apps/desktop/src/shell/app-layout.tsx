import type { ProjectId } from '@10db/contracts';
import {
  AppShell,
  Badge,
  Box,
  Burger,
  Group,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  VisuallyHidden,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconAdjustments,
  IconBulb,
  IconBuildingFactory2,
  IconInbox,
  IconLayoutKanban,
  IconRoute,
  IconSettings,
  IconTools,
} from '@tabler/icons-react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { useDaemonStatus } from '../daemon/provider';
import { useDesktopSync } from '../desktop/sync';
import { useRenderMode } from '../screens/render-context';
import { RenderLayout } from '../screens/render-layout';
import { ScreenRenderHost } from '../screens/screen-render-host';
import { AgentDownloadStatus } from './agent-download-status';
import { ColorSchemeToggle } from './color-scheme-toggle';
import { DaemonStatus } from './daemon-status';
import { KeepAwakeControl } from './keep-awake-control';
import { ProjectSwitcher } from './project-switcher';
import { useOpenInboxCount } from '../views/inbox/inbox-count';
import { useWorkbenchWaitingCount } from '../views/workbench/workbench-count';
import { FirstRun } from '../views/first-run/first-run';
import { SettingsNav } from '../views/settings/settings-nav';
import { firstGlobalSection, SettingsSectionKey } from '../views/settings/sections';
import { ReconnectingBanner } from './reconnecting-banner';
import { useSelectedProject } from './selected-project';
import { ShapeNav } from './shape-nav';

/** What needs the builder and what is running, across every project. */
const GLOBAL_NAV = [
  { to: '/inbox', label: 'Inbox', icon: IconInbox },
  { to: '/factory', label: 'Factory', icon: IconBuildingFactory2 },
] as const;

/** How the selected project's work is shaped; Plan sits among them as `ShapeNav`. */
const PROJECT_NAV = [
  { to: '/board', label: 'Board', icon: IconLayoutKanban },
  { to: '/shape', label: 'Plan', icon: IconRoute },
  { to: '/workbench', label: 'UI Workbench', icon: IconTools },
  { to: '/knowledge', label: 'Knowledge', icon: IconBulb },
] as const;

/**
 * The Workbench sits beside the builder's browser, often 420 to 520 px wide (Workbench spec §4.3): under
 * 900 px its sidebar folds away behind a header button.
 */
const WORKBENCH_FOLD_QUERY = '(max-width: 899px)';

/**
 * Under the shell's `sm` breakpoint (48em) the sidebar would cover the whole window, so every view folds
 * it behind the header button; the window narrows to 420 px.
 */
const SHELL_FOLD_QUERY = '(max-width: 767px)';

/** Clears macOS's traffic lights, which sit over the header's left end. */
const TRAFFIC_LIGHTS_WIDTH = 72;

/** A count on a sidebar item, read by assistive tech as `phrase`. */
function CountBadge({ count, phrase }: { readonly count: number; readonly phrase: string }) {
  return (
    <Badge size="sm" circle>
      {/* The name computation drops a leading space inside VisuallyHidden, so the number is hidden
          from assistive tech and the hidden text carries the whole phrase. */}
      <span aria-hidden="true">{count}</span>
      <VisuallyHidden>{phrase}</VisuallyHidden>
    </Badge>
  );
}

function InboxBadge({ count }: { readonly count: number }) {
  return (
    <CountBadge count={count} phrase={`${String(count)} open card${count === 1 ? '' : 's'}`} />
  );
}

/** The pages of the project's pass that wait on the builder; nothing when none does. */
function WorkbenchBadge({ projectId }: { readonly projectId: ProjectId }) {
  const count = useWorkbenchWaitingCount(projectId);
  if (count === 0) return null;
  return (
    <CountBadge count={count} phrase={`${String(count)} page${count === 1 ? '' : 's'} waiting`} />
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
  const { projects, project, select } = useSelectedProject();
  const navigate = useNavigate();
  const narrow = useMediaQuery(WORKBENCH_FOLD_QUERY);
  const small = useMediaQuery(SHELL_FOLD_QUERY);
  const folded = small || (narrow && pathname === '/workbench');
  // Where the builder opened the folded sidebar; leaving that view folds it again.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const navHidden = folded && openedOn !== pathname;
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
    <AppShell
      header={{ height: 48 }}
      navbar={{
        width: 200,
        breakpoint: 'sm',
        collapsed: { mobile: navHidden, desktop: navHidden },
      }}
      padding="md"
    >
      {/* The window has no title bar: macOS draws its traffic lights over the header's left end, and
          the header's empty space drags the window. */}
      <AppShell.Header data-tauri-drag-region>
        <Group h="100%" px="md" gap="sm" justify="space-between" data-tauri-drag-region>
          <Box pl={TRAFFIC_LIGHTS_WIDTH} data-tauri-drag-region>
            {folded ? (
              <Burger
                size="sm"
                opened={!navHidden}
                aria-label={navHidden ? 'Show navigation' : 'Hide navigation'}
                onClick={() => {
                  setOpenedOn(navHidden ? pathname : null);
                }}
              />
            ) : null}
          </Box>
          <Group gap="sm" data-tauri-drag-region>
            <AgentDownloadStatus />
            <DaemonStatus />
            <KeepAwakeControl />
            <ColorSchemeToggle />
          </Group>
        </Group>
      </AppShell.Header>
      {/* The sidebar sits a Selenized step above the content, so the fills that would match the body
          (active and hover states, the dark/gray scale steps) move up one step inside it. */}
      <AppShell.Navbar
        // A folded sidebar is out of sight, so it is out of the tab order too.
        inert={navHidden}
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
          // Settings lists more sections than a short window holds, so its sidebar scrolls.
          <AppShell.Section grow component={ScrollArea}>
            <SettingsNav />
          </AppShell.Section>
        ) : (
          <>
            {/* Global first, then the selected project's views, then app-wide Settings at the foot:
                the same order the Settings sidebar uses. */}
            <AppShell.Section grow>
              <Stack gap={2}>
                {GLOBAL_NAV.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    component={Link}
                    to={to}
                    active={pathname === to || pathname.startsWith(`${to}/`)}
                    label={label}
                    leftSection={<Icon size={16} stroke={1.5} />}
                    rightSection={
                      to === '/inbox' && openCards > 0 ? (
                        <InboxBadge count={openCards} />
                      ) : undefined
                    }
                  />
                ))}
              </Stack>
              <Stack gap={2} mt="lg">
                <Text size="xs" fw={600} c="dimmed" px="sm" pb={4}>
                  Project
                </Text>
                <ProjectSwitcher compact />
                {PROJECT_NAV.map(({ to, label, icon: Icon }) =>
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
                        to === '/workbench' && project !== null ? (
                          <WorkbenchBadge projectId={project.id} />
                        ) : undefined
                      }
                    />
                  ),
                )}
                <NavLink
                  label="Project Settings"
                  leftSection={<IconAdjustments size={16} stroke={1.5} />}
                  renderRoot={(props) => (
                    <Link
                      {...props}
                      to="/settings/$section"
                      params={{ section: SettingsSectionKey.General }}
                    />
                  )}
                />
              </Stack>
            </AppShell.Section>
            <AppShell.Section>
              <NavLink
                label="Settings"
                leftSection={<IconSettings size={16} stroke={1.5} />}
                renderRoot={(props) => (
                  <Link
                    {...props}
                    to="/settings/$section"
                    params={{ section: firstGlobalSection() }}
                  />
                )}
              />
            </AppShell.Section>
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
