import type { TaskId, WorkstreamDto } from '@10db/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useProjects, useTasksOfProjects } from '../../daemon/queries';
import { useSelectedProject } from '../../shell/selected-project';
import { CancelRunModal } from '../board/cancel-run-modal';
import { ProjectTaskDrawer } from '../board/project-task-drawer';

/**
 * The drawer View Task opens over the Inbox, as Factory opens it over its page: the link names the task alone,
 * so its project is found among every project's tasks. Draws nothing until the task is found.
 */
export function InboxTaskDrawer({
  taskId,
  onClose,
}: {
  readonly taskId: TaskId;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const { select } = useSelectedProject();
  // The run the builder is being asked to confirm cancelling, from the drawer.
  const [cancelling, setCancelling] = useState<WorkstreamDto | null>(null);
  const projects = useProjects().data ?? [];
  const taskLists = useTasksOfProjects(projects.map((p) => p.id));
  const task = taskLists.flatMap((q) => q.data ?? []).find((t) => t.id === taskId);
  const project = task === undefined ? undefined : projects.find((p) => p.id === task.projectId);
  return (
    <>
      {task !== undefined && project !== undefined ? (
        <ProjectTaskDrawer
          key={task.id}
          project={project}
          taskId={task.id}
          onCancelRun={setCancelling}
          onOpenWorkbench={() => {
            select(project.id);
            void navigate({ to: '/workbench' });
          }}
          onOpenBoard={() => {
            select(project.id);
            void navigate({ to: '/board', search: { task: task.id } });
          }}
          onClose={onClose}
        />
      ) : null}
      <CancelRunModal
        run={cancelling}
        onClose={() => {
          setCancelling(null);
        }}
      />
    </>
  );
}
