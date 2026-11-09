import type { ProjectId } from '@10db/contracts';
import { Group, Text } from '@mantine/core';
import { useProjects } from '../daemon/queries';
import { ProjectTile } from './project-tile';

/** Which project something belongs to, in a view that shows every project: its mark and name. */
export function ProjectLabel({ projectId }: { readonly projectId: ProjectId }) {
  const name = useProjects().data?.find((p) => p.id === projectId)?.name;
  if (name === undefined) return null;
  return (
    <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
      <ProjectTile name={name} size={16} />
      <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
        {name}
      </Text>
    </Group>
  );
}
