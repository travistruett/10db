import { Button, Divider, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { Fragment } from 'react';
import { useArchivedProjects, useRestoreProject } from '../../daemon/archive-queries';

/** Settings › Overview: archived projects, each with Restore; absent while there are none. */
export function ArchivedProjectsCard() {
  const archived = useArchivedProjects();
  const restore = useRestoreProject();
  const projects = archived.data ?? [];
  if (projects.length === 0) return null;
  return (
    <Stack gap="xs">
      <Title order={5}>Archived Projects</Title>
      <Paper withBorder radius="md" style={{ overflow: 'hidden' }}>
        {projects.map((project, i) => (
          <Fragment key={project.id}>
            {i > 0 ? <Divider /> : null}
            <Group justify="space-between" wrap="nowrap" p="sm">
              <Stack gap={0} miw={0}>
                <Text size="sm" fw={500}>
                  {project.name}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {project.repoPath.replace(/^\/Users\/[^/]+/u, '~')}
                </Text>
              </Stack>
              <Button
                variant="default"
                size="compact-sm"
                loading={restore.isPending && restore.variables === project.id}
                aria-label={`Restore ${project.name}`}
                onClick={() => {
                  restore.mutate(project.id);
                }}
              >
                Restore
              </Button>
            </Group>
          </Fragment>
        ))}
      </Paper>
      {restore.error ? (
        <Text size="xs" c="red">
          {restore.error.message}
        </Text>
      ) : null}
    </Stack>
  );
}
