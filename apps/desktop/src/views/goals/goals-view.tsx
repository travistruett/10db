import type {
  GoalId,
  GoalSummaryDto,
  ProjectViewDto,
  TaskId,
  WorkstreamDto,
} from '@10db/contracts';
import { Alert, Container } from '@mantine/core';
import { IconTarget } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useGoal, useGoals, useOpenGoal } from '../../daemon/goal-queries';
import { useBatches, useTasks, useWorkstreams } from '../../daemon/queries';
import { ContentWidth } from '../../shell/content-width';
import { EmptyState } from '../../shell/empty-state';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { useSelectedProject } from '../../shell/selected-project';
import { TitleRow } from '../../shell/title-row';
import { BatchSheet } from '../board/batch/batch-sheet';
import { CancelRunModal } from '../board/cancel-run-modal';
import { ProjectTaskDrawer } from '../board/project-task-drawer';
import { taskRows, type TaskRow } from '../factory/task-rows';
import { GoalPage } from './goal-page';
import { GoalsList } from './goals-list';

export interface GoalsViewProps {
  /** The goal whose page is open; absent shows the chosen project's list. */
  readonly goal?: GoalId | undefined;
  /** The task whose drawer is open over the page. */
  readonly task?: TaskId | undefined;
}

/** Goals: the chosen project's list, or one goal's page, which shows the goal's own project. */
export function GoalsView({ goal, task }: GoalsViewProps) {
  const { project, projects, select } = useSelectedProject();
  const one = useGoal(goal ?? null);
  const owner = (projects.data ?? []).find((p) => p.id === one.data?.projectId);
  // A goal's page makes its project the chosen one, so All Goals, the Board and the rail follow it there.
  const ownerId = goal === undefined ? undefined : owner?.id;
  useEffect(() => {
    if (ownerId !== undefined && ownerId !== project?.id) select(ownerId);
  }, [ownerId, project?.id, select]);
  if (goal !== undefined) {
    if (one.isPending || projects.isPending) return <Loading />;
    // A removed goal, or one whose project is gone, is no failure: say so and offer the list.
    if (one.isError || owner === undefined) return <GoalGone />;
    return <ProjectGoals key={goal} project={owner} goalId={goal} taskId={task} />;
  }
  if (projects.isPending) return <Loading />;
  if (projects.isError) return <Failed message={projects.error.message} />;
  if (project === null) return null;
  return <ProjectGoals project={project} goalId={undefined} taskId={task} />;
}

function Loading() {
  return (
    <Container size={ContentWidth.Page} w="100%" pt="md">
      <PageLoading shape={PageLoadingShape.Lines} rows={4} label="Loading the goals" />
    </Container>
  );
}

function Failed({ message }: { readonly message: string }) {
  return (
    <Container size={ContentWidth.Page} w="100%" pt="md">
      <TitleRow title="Goals" />
      <Alert color="red" title="Couldn't load the goals">
        {message}
      </Alert>
    </Container>
  );
}

/** A goal link that finds no goal: it was removed, as Remove Draft Goal does, or its project went. */
function GoalGone() {
  const navigate = useNavigate();
  return (
    <Container size={ContentWidth.Page} w="100%" pt="md">
      <TitleRow title="Goals" />
      <EmptyState
        icon={IconTarget}
        title="This goal is gone"
        action={{
          label: 'All Goals',
          onClick: () => {
            void navigate({ to: '/goals' });
          },
        }}
      >
        It was removed, or its project was. Its tasks, if any were kept, are on the Board.
      </EmptyState>
    </Container>
  );
}

/** The rows of a goal's task list, as Factory's open goal draws them. */
function rowsOf(
  summary: GoalSummaryDto,
  input: {
    readonly tasks: Parameters<typeof taskRows>[0]['tasks'];
    readonly runs: readonly WorkstreamDto[];
    readonly batches: Parameters<typeof taskRows>[0]['batches'];
    readonly gateCommand: string | null;
  },
): TaskRow[] {
  const ids = new Set(summary.goal.taskIds);
  const next = summary.digest.next;
  return taskRows({
    tasks: summary.goal.taskIds.flatMap((id) => input.tasks.filter((t) => t.id === id)),
    workstreams: input.runs.filter((ws) => ids.has(ws.taskId)),
    batches: input.batches,
    nextTaskId: next?.waitsOn.length === 0 ? next.taskId : null,
    gateCommand: input.gateCommand,
  });
}

function ProjectGoals({
  project,
  goalId,
  taskId,
}: {
  readonly project: ProjectViewDto;
  readonly goalId: GoalId | undefined;
  readonly taskId: TaskId | undefined;
}) {
  const goals = useGoals(project.id);
  const tasks = useTasks(project.id);
  const runs = useWorkstreams({ active: false });
  const batches = useBatches(project.id);
  const open = useOpenGoal();
  const navigate = useNavigate();
  const { select } = useSelectedProject();
  const [starting, setStarting] = useState<GoalSummaryDto | null>(null);
  const [cancelling, setCancelling] = useState<WorkstreamDto | null>(null);
  const list = goals.data?.goals ?? [];
  const input = {
    tasks: tasks.data ?? [],
    runs: runs.data ?? [],
    batches: batches.data ?? [],
    gateCommand: project.gateCommand,
  };

  // Opening a goal's page reads its digest once, which moves its "since you last looked" mark; a ref keeps
  // a StrictMode remount from reading it twice and finding its own window closed.
  const shown = list.find((g) => g.goal.id === goalId);
  const openedFor = useRef<GoalId | null>(null);
  const { mutate } = open;
  useEffect(() => {
    if (goalId === undefined || shown === undefined || openedFor.current === goalId) return;
    openedFor.current = goalId;
    mutate(goalId);
  }, [goalId, shown, mutate]);

  if (goals.isPending || tasks.isPending) return <Loading />;
  if (goals.isError) return <Failed message={goals.error.message} />;

  const drawer =
    taskId === undefined ? null : (
      <ProjectTaskDrawer
        key={taskId}
        project={project}
        taskId={taskId}
        onCancelRun={setCancelling}
        onOpenWorkbench={() => {
          select(project.id);
          void navigate({ to: '/workbench' });
        }}
        onOpenBoard={() => {
          select(project.id);
          void navigate({ to: '/board', search: { task: taskId } });
        }}
        onClose={() => {
          void navigate({
            to: '/goals',
            search: goalId === undefined ? {} : { goal: goalId },
            replace: true,
          });
        }}
      />
    );
  const sheet =
    starting === null ? null : (
      <BatchSheet
        project={project}
        opened
        goal={{ id: starting.goal.id, title: starting.goal.title }}
        onClose={() => {
          setStarting(null);
        }}
      />
    );
  const overlays = (
    <>
      {drawer}
      {sheet}
      <CancelRunModal
        run={cancelling}
        onClose={() => {
          setCancelling(null);
        }}
      />
    </>
  );

  if (goalId !== undefined) {
    // A goal just made can be missing from a list read before it; the refetch brings it.
    if (shown === undefined) return goals.isFetching ? <Loading /> : <GoalGone />;
    return (
      <>
        <GoalPage
          project={project}
          summary={shown}
          rows={rowsOf(shown, input)}
          loading={runs.isPending || batches.isPending}
          error={
            tasks.isError
              ? tasks.error.message
              : runs.isError
                ? runs.error.message
                : batches.isError
                  ? batches.error.message
                  : null
          }
          opened={{
            data: open.data?.goalId === goalId ? open.data : undefined,
            error: open.isError && open.variables === goalId ? open.error.message : null,
          }}
          onStart={() => {
            setStarting(shown);
          }}
        />
        {overlays}
      </>
    );
  }
  const ready = new Map<GoalId, number>(
    list.map(
      (g) => [g.goal.id, rowsOf(g, input).filter((r) => r.bucket === 'ready').length] as const,
    ),
  );
  return (
    <>
      <GoalsList project={project} goals={list} ready={ready} onStart={setStarting} />
      {overlays}
    </>
  );
}
