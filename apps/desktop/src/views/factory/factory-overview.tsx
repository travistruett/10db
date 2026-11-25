import {
  InboxState,
  passHoldsTasks,
  WorkstreamState,
  type GoalId,
  type ProjectId,
  type ProjectViewDto,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import { Alert, Container, Stack } from '@mantine/core';
import { ContentWidth } from '../../shell/content-width';
import { IconBuildingFactory2, IconPlus } from '@tabler/icons-react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAdmission } from '../../daemon/admission-queries';
import { goalsQueryOptions } from '../../daemon/goal-queries';
import { livePassesOptions } from '../../daemon/pass-queries';
import { useDaemon } from '../../daemon/provider';
import {
  useBatchesOfProjects,
  useInbox,
  useTasksOfProjects,
  useWorkstreams,
} from '../../daemon/queries';
import { EmptyState } from '../../shell/empty-state';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { useNow } from '../../shell/relative';
import { useSelectedProject } from '../../shell/selected-project';
import { CancelRunModal } from '../board/cancel-run-modal';
import { ProjectTaskDrawer } from '../board/project-task-drawer';
import { canCloseRun, canRetryRun } from '../board/task-state';
import { useNewPlan } from '../sessions/start-fresh-tab';
import { pageStatus } from '../workbench/page-status';
import { passTitle } from '../workbench/pass-title';
import { waitingCount } from '../workbench/queue-order';
import { medianTurnMinutes } from '../workbench/timing';
import { failureCauses, flatRows, waitsOnSomeoneElse } from './factory-summary';
import { GlanceTiles } from './glance-tiles';
import { LiveGroup, liveGroups } from './live-groups';
import { NeedsYouPanel, type WaitingPass } from './needs-you-panel';
import { ProjectList, type BusyPass } from './project-list';

/**
 * Factory under Live: five figures at a glance, then what needs the builder across projects (answers and
 * failures, grouped by cause), then every shown project as an accordion row with its bar, goals and work.
 */
export function FactoryOverview({
  projects,
  filter,
  linkedGoalId,
  openTaskId,
}: {
  readonly projects: readonly ProjectViewDto[];
  readonly filter: ProjectId | null;
  readonly linkedGoalId: GoalId | undefined;
  /** The task whose drawer is open over the page, from the link's `task`. */
  readonly openTaskId: TaskId | undefined;
}) {
  const now = useNow();
  const { client } = useDaemon();
  const { select } = useSelectedProject();
  const navigate = useNavigate();
  const here = useNavigate({ from: '/factory' });
  // The run the builder is being asked to confirm cancelling, from the open task's drawer.
  const [cancelling, setCancelling] = useState<WorkstreamDto | null>(null);
  const newPlan = useNewPlan();
  const shown = filter === null ? projects : projects.filter((p) => p.id === filter);
  const runs = useWorkstreams({ active: false });
  const passesRead = useQuery(livePassesOptions(client));
  const ids = projects.map((p) => p.id);
  const taskLists = useTasksOfProjects(ids);
  const batchLists = useBatchesOfProjects(ids);
  const goalLists = useQueries({ queries: shown.map((p) => goalsQueryOptions(client, p.id)) });
  const inbox = useInbox().data ?? [];
  const admission = useAdmission().data;
  const tasks = new Map(taskLists.flatMap((q) => q.data ?? []).map((t) => [t.id, t]));
  const batches = new Map(batchLists.flatMap((q) => q.data ?? []).map((b) => [b.id, b]));
  const passes = passesRead.data ?? [];
  // A page's run is the pass's (the Workbench's everywhere else), never a line of its own.
  const heldByPass = new Set(
    passes
      .filter((view) => passHoldsTasks(view.pass.state))
      .flatMap((view) => view.pages.map((p) => p.taskId)),
  );
  const inView = (id: ProjectId): boolean => filter === null || id === filter;
  const rows = flatRows(
    liveGroups(
      (runs.data ?? []).filter((ws) => inView(ws.projectId)),
      tasks,
      taskLists.every((q) => q.isSuccess),
      heldByPass,
      now,
    ),
  );
  const livePasses = passes
    .filter((view) => passHoldsTasks(view.pass.state) && inView(view.pass.projectId))
    .map((view) => {
      const clock = { now, medianTurnMinutes: medianTurnMinutes(view.turns) };
      const waiting = waitingCount(
        view.pages.map((page) => ({
          status: pageStatus(page, inbox, clock, view).status,
          readyAt: page.turn?.readyAt ?? null,
        })),
      );
      return {
        key: view.pass.id,
        projectId: view.pass.projectId,
        title: passTitle(view.pages, view.pass.name),
        waiting,
      };
    });
  const waitingPasses: WaitingPass[] = livePasses
    .filter((p) => p.waiting > 0)
    .map((p) => ({ key: p.key, projectId: p.projectId, title: p.title, pages: p.waiting }));
  const busyPasses: BusyPass[] = livePasses.filter((p) => p.waiting === 0);

  const nameOf = (id: ProjectId): string => projects.find((p) => p.id === id)?.name ?? '';
  // Retry shows only where the daemon takes it, as everywhere Retry is offered.
  const canRetry = (ws: WorkstreamDto): boolean => {
    const task = tasks.get(ws.taskId);
    const batch = ws.batchId === null ? undefined : batches.get(ws.batchId);
    return task !== undefined && canRetryRun(task, ws, batch);
  };
  // Close, as the task drawer offers it: the daemon closes a failed run's task and refuses any other.
  const canClose = (ws: WorkstreamDto): boolean =>
    canCloseRun(ws, ws.batchId === null ? undefined : batches.get(ws.batchId));
  // A task opens in its drawer over Factory; the link keeps it, so Back and a shared URL work.
  const open = (ws: WorkstreamDto): void => {
    void here({ search: (prev) => ({ ...prev, task: ws.taskId }) });
  };
  const closeTask = (): void => {
    void here({
      search: (prev) => ({
        ...(prev.goal === undefined ? {} : { goal: prev.goal }),
        ...(prev.project === undefined ? {} : { project: prev.project }),
        ...(prev.view === undefined ? {} : { view: prev.view }),
      }),
      replace: true,
    });
  };
  const openTask = openTaskId === undefined ? undefined : tasks.get(openTaskId);
  const openProject =
    openTask === undefined ? undefined : projects.find((p) => p.id === openTask.projectId);
  const openPass = (projectId: ProjectId): void => {
    select(projectId);
    void navigate({ to: '/workbench' });
  };
  const openInbox = (projectId: ProjectId): void => {
    void navigate({ to: '/inbox', search: { project: projectId } });
  };

  if (runs.isError) {
    return (
      <Alert color="red" title="Couldn't load the runs">
        {runs.error.message}
      </Alert>
    );
  }
  if (
    runs.isPending ||
    passesRead.isPending ||
    taskLists.some((q) => q.isPending) ||
    batchLists.some((q) => q.isPending) ||
    goalLists.some((q) => q.isPending)
  ) {
    return <PageLoading shape={PageLoadingShape.List} rows={4} label="Loading the runs" />;
  }
  const goalsFailed = goalLists.find((q) => q.isError)?.error;
  const anyGoals = goalLists.some((q) => (q.data?.goals.length ?? 0) > 0);
  if (rows.length === 0 && livePasses.length === 0 && !anyGoals && goalsFailed == null) {
    return (
      <EmptyState
        icon={IconBuildingFactory2}
        title="Nothing is running"
        action={{ label: 'New Session', icon: IconPlus, onClick: newPlan }}
      >
        Start a ready task from the Board, or plan new work in a session.
      </EmptyState>
    );
  }

  const of = (group: LiveGroup): WorkstreamDto[] =>
    rows.filter((r) => r.group === group).map((r) => r.run);
  const needsYou = of(LiveGroup.NeedsYou);
  const failed = of(LiveGroup.Failed);
  const causes = failureCauses(failed);
  const waiting = of(LiveGroup.Waiting);
  const openCards = inbox.filter((card) => card.state === InboxState.Open);
  // The card the run waits on names it: its next action's, else the first open card that targets it.
  const cardFor = (ws: WorkstreamDto) => {
    const action = ws.nextAction;
    const named =
      action.kind === 'answer' ? openCards.find((card) => card.id === action.inboxId) : undefined;
    return named ?? openCards.find((card) => card.targets.some((t) => t.workstreamId === ws.id));
  };

  return (
    <Container size={ContentWidth.Page} w="100%">
      <Stack gap={32}>
        <GlanceTiles
          figures={{
            needsYou: needsYou.length + waitingPasses.length,
            failed: failed.length,
            causes: causes.length,
            // Across every project the figure is the Mac's lanes in use, out of its cap; for one project, its runs.
            running:
              filter === null && admission !== undefined
                ? admission.lanesRunning
                : of(LiveGroup.Running).length + busyPasses.length,
            laneCap: filter === null ? (admission?.machineLaneCap ?? null) : null,
            queued: waiting.filter((ws) => ws.state === WorkstreamState.Queued).length,
            inReview: of(LiveGroup.InReview).length,
            merged: of(LiveGroup.Done).length,
          }}
        />
        <NeedsYouPanel
          waiting={needsYou.map((run) => ({ run, card: cardFor(run) }))}
          passes={waitingPasses}
          causes={causes}
          others={waiting.filter(waitsOnSomeoneElse).map((run) => ({ run, card: cardFor(run) }))}
          now={now}
          nameOf={nameOf}
          canRetry={canRetry}
          canClose={canClose}
          onOpen={open}
          onOpenInbox={openInbox}
          onOpenPass={openPass}
        />
        {goalsFailed == null ? null : (
          <Alert color="red" title="Couldn't load the goals">
            {goalsFailed.message}
          </Alert>
        )}
        <ProjectList
          entries={shown.map((project, i) => ({
            project,
            rows: rows.filter((r) => r.run.projectId === project.id),
            passes: busyPasses.filter((p) => p.projectId === project.id),
            asks: waitingPasses.filter((p) => p.projectId === project.id).length,
            goals: goalLists[i]?.data,
          }))}
          goalOf={new Map([...tasks.values()].map((t) => [t.id, t.goalId ?? null]))}
          linkedGoalId={linkedGoalId}
          now={now}
          canRetry={canRetry}
          canClose={canClose}
          onOpen={open}
          onOpenPass={openPass}
        />
      </Stack>
      {openTask && openProject ? (
        <ProjectTaskDrawer
          key={openTask.id}
          project={openProject}
          taskId={openTask.id}
          onCancelRun={setCancelling}
          onOpenWorkbench={() => {
            openPass(openProject.id);
          }}
          onOpenBoard={() => {
            select(openProject.id);
            void navigate({ to: '/board', search: { task: openTask.id } });
          }}
          onClose={closeTask}
        />
      ) : null}
      <CancelRunModal
        run={cancelling}
        onClose={() => {
          setCancelling(null);
        }}
      />
    </Container>
  );
}
