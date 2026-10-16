import { AppShell, Group, NavLink, Text } from '@mantine/core';
import { IconBuildingFactory2, IconInbox, IconListCheck } from '@tabler/icons-react';
import { Link, Outlet } from '@tanstack/react-router';
import { ColorSchemeToggle } from './color-scheme-toggle';
import { DaemonStatus } from './daemon-status';

const NAV = [
  { to: '/factory', label: 'Factory', icon: IconBuildingFactory2 },
  { to: '/inbox', label: 'Inbox', icon: IconInbox },
  { to: '/tasks', label: 'Tasks', icon: IconListCheck },
] as const;

export function AppLayout() {
  return (
    <AppShell header={{ height: 48 }} navbar={{ width: 200, breakpoint: 'sm' }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Text fw={700}>10db</Text>
          <Group gap="sm">
            <DaemonStatus />
            <ColorSchemeToggle />
          </Group>
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
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
