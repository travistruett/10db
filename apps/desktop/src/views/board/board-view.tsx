import {
  BoardStatus,
  TaskStatus,
  WorkspaceMode,
  WorkstreamState,
  type BatchDto,
  type BatchId,
  type ProjectId,
  type ProjectViewDto,
  type TaskDto,
  type TaskId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import { Alert, Button, Group, Loader, Modal, ScrollArea, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useState } from 'react';
import { useBatches, useBoardColumns, useTasks, useWorkstreams } from '../../daemon/queries';
import { ProjectPicker } from '../../shell/project-picker';
import { useSelectedProject } from '../../shell/selected-project';
import { formatAreas } from './areas-text';
import { BatchSheet } from './batch/batch-sheet';
import { BatchHistory } from './batch-history';
import { BatchStrip } from './batch-strip';
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

/** A finished task's pull request: the one its batch opened, once that batch has shipped. */
function shippedPullRequest(
  task: TaskDto,
  workstream: WorkstreamDto | undefined,
  batchById: ReadonlyMap<BatchId, BatchDto>,
): string | undefined {
  if (task.status !== TaskStatus.Done || !workstream?.batchId) return undefined;
  return batchById.get(workstream.batchId)?.prUrl ?? undefined;
}

const isDone = (column: LayoutColumn) =>
  column.key.kind === 'system' && column.key.status === BoardStatus.Done;

interface BoardColumnsProps {
  readonly projectId: ProjectId;
  readonly layout: readonly LayoutColumn[];
  readonly workstreamById: ReadonlyMap<WorkstreamId, WorkstreamDto>;
  readonly batchById: ReadonlyMap<BatchId, BatchDto>;
  readonly peers: ReadonlyMap<TaskId, Pick<TaskDto, 'title' | 'status' | 'boardColumnId'>>;
  /** For each task, a dependent that has started and waits on it; such a task can't be parked. */
  readonly started: ReadonlyMap<TaskId, string>;
}

/** The columns and their cards, with drag and drop; split out so the actions hook gets a project. */
function BoardColumns({
  projectId,
  layout,
  workstreamById,
  batchById,
  peers,
  started,
}: BoardColumnsProps) {
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
      {actions.failure ? (
        <Alert color="red" title={actions.failure.title}>
          {actions.failure.error.message}
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
                  pullRequest={shippedPullRequest(task, ws, batchById)}
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

/** Worktree mode shows every open batch in the daemon's order, newest first; shared mode shows the one current batch. */
function BatchStrips({
  project,
  workstreams,
}: {
  readonly project: ProjectViewDto;
  readonly workstreams: readonly WorkstreamDto[];
}) {
  if (project.workspaceMode === WorkspaceMode.Worktree && project.openBatches.length > 0) {
    return project.openBatches.map((batch) => (
      <BatchStrip
        key={batch.id}
        batch={batch}
        workstreams={workstreams}
        workspaceMode={project.workspaceMode}
      />
    ));
  }
  return project.currentBatch ? (
    <BatchStrip
      batch={project.currentBatch}
      workstreams={workstreams}
      workspaceMode={project.workspaceMode}
    />
  ) : null;
}

export function BoardView() {
  const { projects, project, select } = useSelectedProject();
  const tasks = useTasks(project?.id ?? null);
  const columns = useBoardColumns(project?.id ?? null);
  const workstreams = useWorkstreams({ active: false });
  const batches = useBatches(project?.id ?? null);
  const [projectOpen, projectModal] = useDisclosure(false);
  const [taskOpen, taskModal] = useDisclosure(false);
  const [sheetOpen, sheet] = useDisclosure(false);

  const taskList = tasks.data ?? [];
  // Without the columns a parked card has nowhere to go, so it is left out rather than shown in a derived column.
  const shownTasks = columns.data ? taskList : taskList.filter((t) => t.boardColumnId === null);
  const layout = boardLayout(columns.data ?? [], shownTasks);
  const workstreamById = new Map((workstreams.data ?? []).map((ws) => [ws.id, ws]));
  const batchList = batches.data ?? [];
  const batchById = new Map(batchList.map((b) => [b.id, b]));
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
          {project ? (
            <Button size="sm" onClick={sheet.open}>
              Start a batch
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
          <Stack gap={4}>
            <Text size="sm">{columns.error.message}</Text>
            {columns.data ? null : (
              <Text size="sm">Parked tasks are hidden until the columns load.</Text>
            )}
          </Stack>
        </Alert>
      ) : null}
      {workstreams.isError ? (
        <Alert color="red" title="Couldn't load the workstreams">
          {workstreams.error.message}
        </Alert>
      ) : null}
      {batches.isError ? (
        <Alert color="red" title="Couldn't load the batches">
          {batches.error.message}
        </Alert>
      ) : null}
      {projects.isPending ? <Loader size="sm" aria-label="Loading projects" /> : null}
      {projects.isSuccess && !project ? (
        <Text c="dimmed">No projects yet. Create one to start.</Text>
      ) : null}
      {project ? (
        <Text size="sm" c="dimmed" ff="monospace" style={{ whiteSpace: 'pre-wrap' }}>
          {project.repoPath} · gate: {project.gateCommand ?? 'none'}
          {'\n'}
          {formatAreas(project.areas)}
        </Text>
      ) : null}
      {project ? <BatchStrips project={project} workstreams={workstreams.data ?? []} /> : null}
      {project && batchList.length > 0 ? <BatchHistory batches={batchList} /> : null}

      {project && tasks.isSuccess && taskList.length === 0 ? (
        <Text c="dimmed">No tasks yet.</Text>
      ) : null}
      {project && tasks.isSuccess && (columns.data !== undefined || columns.isError) ? (
        <BoardColumns
          projectId={project.id}
          layout={layout}
          workstreamById={workstreamById}
          batchById={batchById}
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
        <BatchSheet key={project.id} project={project} opened={sheetOpen} onClose={sheet.close} />
      ) : null}
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
