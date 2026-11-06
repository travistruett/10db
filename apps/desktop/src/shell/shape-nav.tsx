import { ShapeState, type ShapeDto } from '@10db/contracts';
import { NavLink } from '@mantine/core';
import { IconRoute } from '@tabler/icons-react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useShapes } from '../daemon/shape-queries';
import { useSelectedProject } from './selected-project';

/** The selected project's most recent conversation not yet converted, a running turn included. */
export function latestOpenShape(shapes: readonly ShapeDto[] | undefined): ShapeDto | undefined {
  // `useShapes` lists the most recently updated first.
  return shapes?.find((shape) => shape.state !== ShapeState.Converted);
}

/**
 * Plan's nav item (the route and the code keep the name Shape). It lists no conversations. It opens
 * the selected project's latest conversation that hasn't been converted, and the blank composer
 * (`/shape`) when there is none or the list hasn't arrived. It is a plain link whose target follows
 * the project's list, so `/shape` itself never redirects and Plan's New can still reach the composer.
 */
export function ShapeNav({ pathname }: { readonly pathname: string }) {
  const { project } = useSelectedProject();
  const navigate = useNavigate();
  const shapes = useShapes(project?.id ?? null);
  // A list is keyed by project, so another project's conversation can't be offered after a switch.
  const latest = latestOpenShape(shapes.data);
  const active = pathname === '/shape' || pathname.startsWith('/shape/');
  const icon = <IconRoute size={16} stroke={1.5} />;
  if (!latest) {
    return <NavLink component={Link} to="/shape" active={active} label="Plan" leftSection={icon} />;
  }
  // A plain anchor the router navigates, so the conversation's id is typed at this one call site.
  return (
    <NavLink
      component="a"
      href={`/shape/${latest.id}`}
      active={active}
      label="Plan"
      leftSection={icon}
      onClick={(event: React.MouseEvent) => {
        event.preventDefault();
        void navigate({ to: '/shape/$shapeId', params: { shapeId: latest.id } });
      }}
    />
  );
}
