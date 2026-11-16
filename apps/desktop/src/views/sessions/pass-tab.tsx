import type { ProjectViewDto, TaskSessionDto } from '@10db/contracts';
import { Box } from '@mantine/core';
import { TaskBar } from './task-bar';

export interface PassTabProps {
  readonly session: TaskSessionDto;
  readonly project: ProjectViewDto | undefined;
}

/** A pass of one's tab: filled in beside the Workbench's page views. */
export function PassTab({ session }: PassTabProps) {
  return (
    <Box style={{ flex: 1 }}>
      <TaskBar title={session.title} taskId={session.taskId} kindLine="Task · Your folder" />
    </Box>
  );
}
