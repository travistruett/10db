import type { ProjectViewDto } from '@10db/contracts';
import { Box, Text } from '@mantine/core';
import { useTaskSession } from '../../daemon/task-session-queries';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { CopyTab } from './copy-tab';
import { PassTab } from './pass-tab';
import type { TaskTab as TaskTabEntry } from './task-tabs';

export interface TaskTabProps {
  readonly tab: TaskTabEntry;
  readonly project: ProjectViewDto | undefined;
}

/**
 * A task's tab (sessions UI §8.4): a separate copy shows its thread and where its run stands; a pass of one
 * shows its one page, with Sign Off and Close Pass….
 */
export function TaskTab({ tab, project }: TaskTabProps) {
  const session = useTaskSession(tab.taskId);
  if (session.data === undefined)
    return (
      <Box px="md" pt="md" role="status" aria-label="Task">
        {session.isError ? (
          <Text size="sm" c="dimmed">
            This task can’t be read: {session.error.message}
          </Text>
        ) : (
          <PageLoading shape={PageLoadingShape.Lines} label="Loading the task" />
        )}
      </Box>
    );
  return session.data.place === 'pass' ? (
    <PassTab session={session.data} project={project} />
  ) : (
    <CopyTab session={session.data} project={project} />
  );
}
