import { NavLink } from '@mantine/core';
import { IconRoute } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';

/**
 * Plan's nav item (the route and the code keep the name Shape). It lists no conversations: the
 * view shows a project's past ones under the composer and behind History.
 */
export function ShapeNav({ pathname }: { readonly pathname: string }) {
  return (
    <NavLink
      component={Link}
      to="/shape"
      active={pathname === '/shape' || pathname.startsWith('/shape/')}
      label="Plan"
      leftSection={<IconRoute size={16} stroke={1.5} />}
    />
  );
}
