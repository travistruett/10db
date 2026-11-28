import { Badge } from '@mantine/core';
import { ProjectTile } from './project-tile';

/**
 * The project a page shows, beside its title in the title row: its tile and name. A page that shows every
 * project, or none, shows no badge.
 */
export function ScopeBadge({ name }: { readonly name: string }) {
  return (
    <Badge
      variant="light"
      color="gray"
      tt="none"
      fw={500}
      size="md"
      leftSection={<ProjectTile name={name} size={14} />}
    >
      {name}
    </Badge>
  );
}
