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
import { Alert, Button, Group, Loader, Menu, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconColumns, IconPlayerPlay, IconPlus } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useBatches, useBoardColumns, useTasks, useWorkstreams } from '../../daemon/queries';
import { FormModal } from '../../shell/form-modal';
import { useSelectedProject } from '../../shell/selected-project';
import { SplitButton } from '../../shell/split-button';
import { SettingsSectionKey } from '../settings/sections';
import { BatchSheet } from './batch/batch-sheet';
import { BatchHistory } from './batch-history';
import { BatchStrip } from './batch-strip';
import { BoardColumn } from './board-column';
import { BoardScroll } from './board-scroll';
import { columnHint } from './column-hints';
import { BoardDnd } from './board-dnd';
import { boardLayout, DONE_LIMIT, type LayoutColumn } from './board-layout';
import { menuMoves, resolveDrop, startedDependents, type DropTarget } from './drop-rules';
import { NewProjectForm } from './new-project-form';
import { NewTaskForm } from './new-task-form';
import { PullRequestLink } from './pull-request-link';
import { cardSummary, TaskCard } from './task-card';
import { TaskCardMenu } from './task-card-menu';
import { columnNameOf, TaskDrawer } from './task-drawer';
import { useBoardActions } from './use-board-actions';

const NEW_TASK_FORM_ID = 'new-task-form';

/** The columns never shrink below this, however many strips sit above them. */
const COLUMNS_MIN_HEIGHT = 320;
/** The strips and history together take at most this share of the board's height. */
const ABOVE_COLUMNS_MAX_HEIGHT = '33%';

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

const isReady = (column: LayoutColumn) =>
  column.key.kind === 'system' && column.key.status === BoardStatus.Ready;

interface BoardColumnsProps {
  readonly projectId: ProjectId;
  readonly layout: readonly LayoutColumn[];
  readonly workstreamById: ReadonlyMap<WorkstreamId, WorkstreamDto>;
  readonly batchById: ReadonlyMap<BatchId, BatchDto>;
  readonly peers: ReadonlyMap<TaskId, Pick<TaskDto, 'title' | 'status' | 'boardColumnId'>>;
  /** For each task, a dependent that has started and waits on it; such a task can't be parked. */
  readonly started: ReadonlyMap<TaskId, string>;
  /** Opens the New Task form from the foot of Ready. */
  readonly onAddTask: () => void;
}

/** The columns and their cards, with drag and drop; split out so the actions hook gets a project. */
function BoardColumns({
  projectId,
  layout,
  workstreamById,
  batchById,
  peers,
  started,
  onAddTask,
}: BoardColumnsProps) {
  const actions = useBoardActions(projectId);
  const [showAllDone, setShowAllDone] = useState(false);
  // The task whose details are open, by ID, so the drawer follows the task as the board refetches.
  const [openId, setOpenId] = useState<TaskId | null>(null);
  const openTask = layout.flatMap((c) => c.tasks).find((t) => t.id === openId);
  const openWorkstream = openTask?.workstreamId
    ? workstreamById.get(openTask.workstreamId)
    : undefined;
  const humanColumns = new Map(
    layout.flatMap((c) => (c.key.kind === 'human' ? [[c.key.id, c.label] as const] : [])),
  );
  const drop = (taskId: TaskId, target: DropTarget) => {
    actions.apply(resolveDrop(layout, taskId, target, started));
  };
  const accepts = (taskId: TaskId, target: DropTarget) => {
    const kind = resolveDrop(layout, taskId, target, started).kind;
    return kind === 'move' || kind === 'start';
  };
  return (
    <Stack flex={1} mih={COLUMNS_MIN_HEIGHT} data-testid="board-columns">
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
      <BoardScroll>
        <BoardDnd
          layout={layout}
          shown={(column) =>
            isDone(column) && !showAllDone ? column.tasks.slice(0, DONE_LIMIT) : column.tasks
          }
          onDrop={drop}
          accepts={accepts}
          onOpen={(task) => {
            setOpenId(task.id);
          }}
          renderColumn={(column, cards, listRef, targeted) => (
            <BoardColumn
              listRef={listRef}
              targeted={targeted}
              label={column.label}
              count={column.tasks.length}
              hint={columnHint(column)}
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
                ) : isReady(column) ? (
                  <Button
                    variant="default"
                    size="xs"
                    fullWidth
                    style={{ borderStyle: 'dashed' }}
                    onClick={onAddTask}
                  >
                    Add Task
                  </Button>
                ) : null
              }
            >
              {cards}
            </BoardColumn>
          )}
          renderCard={(task) => {
            const ws = task.workstreamId ? workstreamById.get(task.workstreamId) : undefined;
            return (
              <TaskCard
                task={task}
                workstream={ws && SHOWN_STATES.includes(ws.state) ? ws : undefined}
                pullRequest={shippedPullRequest(task, ws, batchById)}
                peers={peers}
              />
            );
          }}
          renderLink={(task) => {
            const url = shippedPullRequest(
              task,
              task.workstreamId ? workstreamById.get(task.workstreamId) : undefined,
              batchById,
            );
            return url ? <PullRequestLink url={url} /> : null;
          }}
          summary={(task) => {
            const ws = task.workstreamId ? workstreamById.get(task.workstreamId) : undefined;
            return cardSummary(task, ws && SHOWN_STATES.includes(ws.state) ? ws : undefined, peers);
          }}
          renderMenu={(task) => {
            const ws = task.workstreamId ? workstreamById.get(task.workstreamId) : undefined;
            return (
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
            );
          }}
        />
      </BoardScroll>
      {openTask ? (
        <TaskDrawer
          key={openTask.id}
          task={openTask}
          columnName={columnNameOf(openTask, humanColumns)}
          peers={peers}
          {...(openWorkstream ? { workstream: openWorkstream } : {})}
          onClose={() => {
            setOpenId(null);
          }}
        />
      ) : null}
    </Stack>
  );
}

/** Worktree mode shows every open batch in the daemon's order, newest first; shared mode shows the one current batch. */
function stripBatches(project: ProjectViewDto): readonly BatchDto[] {
  if (project.workspaceMode === WorkspaceMode.Worktree && project.openBatches.length > 0) {
    return project.openBatches;
  }
  return project.currentBatch ? [project.currentBatch] : [];
}

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
  const navigate = useNavigate();
  const [projectOpen, projectModal] = useDisclosure(false);
  const [taskOpen, taskModal] = useDisclosure(false);
  const [taskStatus, setTaskStatus] = useState<{ pending: boolean; error: string | null }>({
    pending: false,
    error: null,
  });
  const [sheetOpen, sheet] = useDisclosure(false);

  const taskList = tasks.data ?? [];
  // Without the columns a parked card has nowhere to go, so it is left out rather than shown in a derived column.
  const shownTasks = columns.data ? taskList : taskList.filter((t) => t.boardColumnId === null);
  const layout = boardLayout(columns.data ?? [], shownTasks);
  const workstreamById = new Map((workstreams.data ?? []).map((ws) => [ws.id, ws]));
  const batchList = batches.data ?? [];
  const batchById = new Map(batchList.map((b) => [b.id, b]));
  const stripIds = new Set((project ? stripBatches(project) : []).map((b) => b.id));
  const historyBatches = batchList.filter((b) => !stripIds.has(b.id));
  const peers = new Map(taskList.map((t) => [t.id, t]));
  const started = startedDependents(taskList, workstreamById);
  const readyCount = layout.find(isReady)?.tasks.length ?? 0;

  return (
    <Stack h="calc(100dvh - var(--app-shell-header-offset, 0px) - 2 * var(--mantine-spacing-md))">
      <Group justify="flex-end" align="flex-end">
        <Group align="flex-end">
          <Button variant="default" size="sm" onClick={projectModal.open}>
            New project
          </Button>
          {project ? (
            <SplitButton
              leftSection={<IconPlus size={16} stroke={1.5} />}
              onClick={taskModal.open}
              menuLabel="More board actions"
              menu={
                <>
                  <Menu.Item
                    leftSection={<IconPlayerPlay size={16} stroke={1.5} />}
                    disabled={readyCount === 0}
                    onClick={sheet.open}
                  >
                    {/* The count shares the label's baseline; as a right section it centers on a different box. */}
                    <Group justify="space-between" align="baseline" wrap="nowrap" gap="md">
                      <span>Start Ready Tasks…</span>
                      <Text span size="xs" c="dimmed">
                        {readyCount === 0 ? 'Nothing in Ready' : `${String(readyCount)} ready`}
                      </Text>
                    </Group>
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconColumns size={16} stroke={1.5} />}
                    onClick={() => {
                      void navigate({
                        to: '/settings/$section',
                        params: { section: SettingsSectionKey.BoardColumns },
                      });
                    }}
                  >
                    Add Column…
                  </Menu.Item>
                </>
              }
            >
              New Task
            </SplitButton>
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
      {project && (stripIds.size > 0 || historyBatches.length > 0) ? (
        <ScrollArea.Autosize
          mah={ABOVE_COLUMNS_MAX_HEIGHT}
          type="auto"
          offsetScrollbars="y"
          data-testid="board-above-columns"
        >
          <Stack gap="sm">
            <BatchStrips project={project} workstreams={workstreams.data ?? []} />
            {historyBatches.length > 0 ? <BatchHistory batches={historyBatches} /> : null}
          </Stack>
        </ScrollArea.Autosize>
      ) : null}

      {project && tasks.isSuccess && (columns.data !== undefined || columns.isError) ? (
        <BoardColumns
          projectId={project.id}
          layout={layout}
          workstreamById={workstreamById}
          batchById={batchById}
          peers={peers}
          started={started}
          onAddTask={taskModal.open}
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
        <FormModal
          opened={taskOpen}
          onClose={taskModal.close}
          title="New Task"
          error={taskStatus.error}
          actions={
            <>
              <Button variant="default" onClick={taskModal.close}>
                Cancel
              </Button>
              <Button type="submit" form={NEW_TASK_FORM_ID} loading={taskStatus.pending}>
                Create Task
              </Button>
            </>
          }
        >
          <NewTaskForm
            key={project.id}
            formId={NEW_TASK_FORM_ID}
            onStatus={setTaskStatus}
            project={project}
            tasks={taskList}
            onCreated={taskModal.close}
          />
        </FormModal>
      ) : null}
    </Stack>
  );
}
