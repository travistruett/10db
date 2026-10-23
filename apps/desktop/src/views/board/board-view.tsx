import {
  BoardStatus,
  TaskStatus,
  WorkstreamState,
  type ProjectId,
  type TaskDto,
  type TaskId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import { Alert, Button, Group, Loader, Modal, ScrollArea, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useState } from 'react';
import { useBoardColumns, useTasks, useWorkstreams } from '../../daemon/queries';
import { ProjectPicker } from '../../shell/project-picker';
import { useSelectedProject } from '../../shell/selected-project';
import { formatAreas } from './areas-text';
import { BoardColumn } from './board-column';
import { BoardDnd } from './board-dnd';
import { boardLayout, DONE_LIMIT, type LayoutColumn } from './board-layout';
import { menuMoves, resolveDrop, startedDependents, type DropTarget } from './drop-rules';
import { NewProjectForm } from './new-project-form';
import { NewTaskForm } from './new-task-form';
import { TaskCard } from './task-card';
import { TaskCardMenu } from './task-card-menu';
import { useBoardActions } from './use-board-actions';

/** A finished workstream isn't repeated on its card; the task's column already says so. */
const SHOWN_STATES: readonly WorkstreamState[] = Object.values(WorkstreamState).filter(
  (s) => s !== WorkstreamState.Done && s !== WorkstreamState.Cancelled,
);

/** The first unfinished dependency that sits in a human column, if any. */
function parkedDependencyOf(
  task: TaskDto,
  peers: ReadonlyMap<TaskId, Pick<TaskDto, 'title' | 'status' | 'boardColumnId'>>,
): string | null {
  for (const id of task.dependsOn) {
    const peer = peers.get(id);
    if (peer?.status === TaskStatus.Open && peer.boardColumnId !== null) return peer.title;
  }
  return null;
}

const isDone = (column: LayoutColumn) =>
  column.key.kind === 'system' && column.key.status === BoardStatus.Done;

interface BoardColumnsProps {
  readonly projectId: ProjectId;
  readonly layout: readonly LayoutColumn[];
  readonly workstreamById: ReadonlyMap<WorkstreamId, WorkstreamDto>;
  readonly peers: ReadonlyMap<TaskId, Pick<TaskDto, 'title' | 'status' | 'boardColumnId'>>;
  /** For each task, a dependent that has started and waits on it; such a task can't be parked. */
  readonly started: ReadonlyMap<TaskId, string>;
}

/** The columns and their cards, with drag and drop; split out so the actions hook gets a project. */
function BoardColumns({ projectId, layout, workstreamById, peers, started }: BoardColumnsProps) {
  const actions = useBoardActions(projectId);
  const [showAllDone, setShowAllDone] = useState(false);
  const drop = (taskId: TaskId, target: DropTarget) => {
    actions.apply(resolveDrop(layout, taskId, target, started));
  };
  return (
    <Stack>
      {actions.notice ? (
        <Alert color="yellow" withCloseButton onClose={actions.dismiss}>
          {actions.notice}
        </Alert>
      ) : null}
      {actions.error ? (
        <Alert color="red" title="Couldn't move the task">
          {actions.error.message}
        </Alert>
      ) : null}
      <ScrollArea type="auto" offsetScrollbars>
        <Group align="flex-start" wrap="nowrap" gap="sm">
          <BoardDnd
            layout={layout}
            shown={(column) =>
              isDone(column) && !showAllDone ? column.tasks.slice(0, DONE_LIMIT) : column.tasks
            }
            onDrop={drop}
            renderColumn={(column, cards, listRef) => (
              <BoardColumn
                listRef={listRef}
                label={column.label}
                count={column.tasks.length}
                locked={column.key.kind === 'system'}
                footer={
                  isDone(column) && !showAllDone && column.tasks.length > DONE_LIMIT ? (
                    <Button
                      variant="subtle"
                      size="xs"
                      onClick={() => {
                        setShowAllDone(true);
                      }}
                    >
                      {`Show all ${String(column.tasks.length)}`}
                    </Button>
                  ) : null
                }
              >
                {cards}
              </BoardColumn>
            )}
            renderCard={(task, handle) => {
              const ws = task.workstreamId ? workstreamById.get(task.workstreamId) : undefined;
              return (
                <TaskCard
                  task={task}
                  workstream={ws && SHOWN_STATES.includes(ws.state) ? ws : undefined}
                  peers={peers}
                  handle={handle}
                  menu={
                    <TaskCardMenu
                      task={task}
                      latest={ws?.state}
                      parkedDependency={parkedDependencyOf(task, peers)}
                      moves={menuMoves(layout, task.id, started)}
                      onMove={(target) => {
                        drop(task.id, target);
                      }}
                      onStart={() => {
                        actions.apply({ kind: 'start', taskId: task.id });
                      }}
                    />
                  }
                />
              );
            }}
          />
        </Group>
      </ScrollArea>
    </Stack>
  );
}

export function BoardView() {
  const { projects, project, select } = useSelectedProject();
  const tasks = useTasks(project?.id ?? null);
  const columns = useBoardColumns(project?.id ?? null);
  const workstreams = useWorkstreams({ active: false });
  const [projectOpen, projectModal] = useDisclosure(false);
  const [taskOpen, taskModal] = useDisclosure(false);

  const taskList = tasks.data ?? [];
  const layout = boardLayout(columns.data ?? [], taskList);
  const workstreamById = new Map((workstreams.data ?? []).map((ws) => [ws.id, ws]));
  const peers = new Map(taskList.map((t) => [t.id, t]));
  const started = startedDependents(taskList, workstreamById);

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <Title order={2}>Board</Title>
        <Group align="flex-end">
          {project ? (
            <ProjectPicker
              value={project.id}
              onChange={(id) => {
                select(id);
              }}
            />
          ) : null}
          <Button variant="default" size="sm" onClick={projectModal.open}>
            New project
          </Button>
          {project ? (
            <Button size="sm" onClick={taskModal.open}>
              New task
            </Button>
          ) : null}
        </Group>
      </Group>

      {projects.isError ? (
        <Alert color="red" title="Couldn't load the projects">
          {projects.error.message}
        </Alert>
      ) : null}
      {tasks.isError ? (
        <Alert color="red" title="Couldn't load the tasks">
          {tasks.error.message}
        </Alert>
      ) : null}
      {columns.isError ? (
        <Alert color="red" title="Couldn't load the board columns">
          {columns.error.message}
        </Alert>
      ) : null}
      {workstreams.isError ? (
        <Alert color="red" title="Couldn't load the workstreams">
          {workstreams.error.message}
        </Alert>
      ) : null}
      {projects.isPending ? <Loader size="sm" aria-label="Loading projects" /> : null}
      {projects.isSuccess && !project ? (
        <Text c="dimmed">No projects yet. Create one to start.</Text>
      ) : null}
      {project ? (
        <Text size="sm" c="dimmed" ff="monospace" style={{ whiteSpace: 'pre-wrap' }}>
          {project.repoPath} · gate: {project.gateCommand}
          {'\n'}
          {formatAreas(project.areas)}
        </Text>
      ) : null}

      {project && tasks.isSuccess && taskList.length === 0 ? (
        <Text c="dimmed">No tasks yet.</Text>
      ) : null}
      {project && tasks.isSuccess && columns.isSuccess ? (
        <BoardColumns
          projectId={project.id}
          layout={layout}
          workstreamById={workstreamById}
          peers={peers}
          started={started}
        />
      ) : null}

      <Modal opened={projectOpen} onClose={projectModal.close} title="New project" size="lg">
        <NewProjectForm
          onCreated={(created) => {
            select(created.id);
            projectModal.close();
          }}
        />
      </Modal>
      {project ? (
        <Modal opened={taskOpen} onClose={taskModal.close} title="New task" size="lg">
          <NewTaskForm
            key={project.id}
            project={project}
            tasks={taskList}
            onCreated={taskModal.close}
          />
        </Modal>
      ) : null}
    </Stack>
  );
}
