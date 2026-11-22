import {
  passHoldsTasks,
  WorkstreamState,
  type ProjectId,
  type ProjectViewDto,
  type WorkstreamDto,
} from '@10db/contracts';
import { Alert, Button, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconTools } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useNewPlan } from '../sessions/start-fresh-tab';
import type { ReactNode } from 'react';
import { livePassesOptions } from '../../daemon/pass-queries';
import { useDaemon } from '../../daemon/provider';
import {
  useBatchesOfProjects,
  useInbox,
  useRetryWorkstream,
  useTasksOfProjects,
  useWorkstreams,
} from '../../daemon/queries';
import { canRetryRun } from '../board/task-state';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { useNow } from '../../shell/relative';
import { ProjectTile } from '../../shell/project-tile';
import { useSelectedProject } from '../../shell/selected-project';
import { pageStatus } from '../workbench/page-status';
import { waitingCount } from '../workbench/queue-order';
import { passTitle } from '../workbench/pass-title';
import { medianTurnMinutes } from '../workbench/timing';
import { LIVE_GROUP_LABELS, LiveGroup, lastMoment, liveGroups } from './live-groups';
import classes from './live-list.module.css';
import { shortAgo } from './short-ago';
import { StatusDot } from './status-dot';
import { STATE_COLORS } from './workstream-state';

const S = WorkstreamState;

/** What a run is doing, in a few words after its title. */
function doing(ws: WorkstreamDto): string {
  switch (ws.state) {
    case S.WaitingHuman:
      return ws.waitingOn === null
        ? 'Waiting on you'
        : `Question out with ${ws.waitingOn.names.join(', ')}`;
    case S.Failed:
      return ws.failureReason ?? 'Failed';
    case S.Queued:
      return ws.notice?.line ?? 'Waiting for a free lane';
    case S.Held:
      return 'Held, not in the queue';
    case S.PausedLimit:
      return 'Paused until the usage limit resets';
    case S.Recovering:
      return 'Recovering';
    case S.TakenOver:
      return 'In your terminal';
    case S.Done:
      return 'Done';
    case S.Cancelled:
      return 'Cancelled';
    case S.Starting:
    case S.Running:
    case S.HandingOff:
    case S.Verifying: {
      const step = ws.steps[ws.stepIndex];
      if (step === undefined) return ws.model;
      return `${step.role} · step ${String(ws.stepIndex + 1)} of ${String(ws.steps.length)} · ${step.model}`;
    }
  }
}

function Row({
  project,
  dot,
  title,
  detail,
  when,
  icon,
  action,
  onOpen,
}: {
  readonly project: string;
  readonly dot: string;
  readonly title: string;
  readonly detail: string;
  readonly when: string;
  readonly icon?: ReactNode;
  /** A control at the row's end, beside the link rather than inside it (a failed run's Retry). */
  readonly action?: ReactNode;
  readonly onOpen: () => void;
}) {
  return (
    <div className={classes['row']}>
      <UnstyledButton className={classes['open']} onClick={onOpen}>
        <StatusDot color={dot} />
        <span className={classes['title']}>{title}</span>
        {icon}
        <span className={classes['detail']}>{detail}</span>
        <span className={classes['project']}>
          <ProjectTile name={project} size={14} />
          <span className={classes['projectName']}>{project}</span>
        </span>
        <span className={classes['when']}>{when}</span>
      </UnstyledButton>
      {/* Every row keeps the slot, so the project and time columns line up whether or not a row has one. */}
      <span className={classes['action']}>{action}</span>
    </div>
  );
}

/** A section of Factory's page: a dim label and its count over its rows. */
export function Section({
  label,
  count,
  children,
}: {
  readonly label: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <div role="group" className={classes['section']} aria-label={label}>
      <div className={classes['head']}>
        {label}
        <span className={classes['count']}>{count}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * Factory's live list: what every project's runs are doing now, by what the builder would do about it
 * rather than by project. A live UI Workbench pass is a row too. Nothing going on says so once.
 */
export function LiveList({
  projects,
  filter,
}: {
  readonly projects: readonly ProjectViewDto[];
  readonly filter: ProjectId | null;
}) {
  const now = useNow();
  const { client } = useDaemon();
  const { select } = useSelectedProject();
  const navigate = useNavigate();
  const newPlan = useNewPlan();
  const runs = useWorkstreams({ active: false });
  const passesRead = useQuery(livePassesOptions(client));
  const ids = projects.map((p) => p.id);
  const taskLists = useTasksOfProjects(ids);
  const batchLists = useBatchesOfProjects(ids);
  const all = runs.data ?? [];
  const passes = passesRead.data ?? [];
  const tasks = new Map(taskLists.flatMap((q) => q.data ?? []).map((t) => [t.id, t]));
  const batches = new Map(batchLists.flatMap((q) => q.data ?? []).map((b) => [b.id, b]));
  // A page's run is the pass's row (the Workbench's everywhere else), never a row of its own.
  const heldByPass = new Set(
    passes
      .filter((view) => passHoldsTasks(view.pass.state))
      .flatMap((view) => view.pages.map((p) => p.taskId)),
  );
  const inbox = useInbox().data ?? [];
  const retry = useRetryWorkstream();
  const nameOf = (id: ProjectId): string => projects.find((p) => p.id === id)?.name ?? '';
  const inView = (id: ProjectId): boolean => filter === null || id === filter;
  const groups = liveGroups(
    all.filter((ws) => inView(ws.projectId)),
    tasks,
    taskLists.every((q) => q.isSuccess),
    heldByPass,
    now,
  );
  const live = passes.filter(
    (view) => passHoldsTasks(view.pass.state) && inView(view.pass.projectId),
  );
  const passRows = live.map((view) => {
    const clock = { now, medianTurnMinutes: medianTurnMinutes(view.turns) };
    const waiting = waitingCount(
      view.pages.map((page) => ({
        status: pageStatus(page, inbox, clock, view).status,
        readyAt: page.turn?.readyAt ?? null,
      })),
    );
    return { view, waiting };
  });
  // Retry shows only where the daemon takes it, as everywhere Retry is offered.
  const canRetryHere = (ws: WorkstreamDto): boolean => {
    const task = tasks.get(ws.taskId);
    const batch = ws.batchId === null ? undefined : batches.get(ws.batchId);
    return task !== undefined && canRetryRun(task, ws, batch);
  };
  const open = (ws: WorkstreamDto): void => {
    select(ws.projectId);
    void navigate({ to: '/board', search: { task: ws.taskId } });
  };
  const openPass = (projectId: ProjectId): void => {
    select(projectId);
    void navigate({ to: '/workbench' });
  };
  const passRow = ({ view, waiting }: (typeof passRows)[number]) => (
    <Row
      key={view.pass.id}
      project={nameOf(view.pass.projectId)}
      dot={waiting > 0 ? 'yellow' : 'blue'}
      title={passTitle(view.pages, view.pass.name)}
      icon={<IconTools size={14} stroke={1.5} className={classes['icon']} aria-hidden />}
      detail={
        waiting > 0
          ? `UI Workbench · ${String(waiting)} ${waiting === 1 ? 'page' : 'pages'} waiting on you`
          : 'UI Workbench'
      }
      when=""
      onOpen={() => {
        openPass(view.pass.projectId);
      }}
    />
  );

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
    batchLists.some((q) => q.isPending)
  ) {
    return <PageLoading shape={PageLoadingShape.List} rows={4} label="Loading the runs" />;
  }
  if (groups.length === 0 && passRows.length === 0) {
    return (
      <Stack align="flex-start" gap="xs" className={classes['empty']}>
        <Text size="sm">Nothing is running.</Text>
        <Text size="sm" c="dimmed">
          Start ready tasks from the Board, or plan new work.
        </Text>
        <Button onClick={newPlan} size="xs" mt={4}>
          New Session
        </Button>
      </Stack>
    );
  }

  const waitingPasses = passRows.filter((p) => p.waiting > 0);
  const busyPasses = passRows.filter((p) => p.waiting === 0);
  const sections: { group: LiveGroup; rows: readonly WorkstreamDto[] }[] = [...groups];
  const has = (g: LiveGroup): boolean => sections.some((s) => s.group === g);
  // A pass waiting on the builder sits under Needs You, a busy one under Running.
  if (waitingPasses.length > 0 && !has(LiveGroup.NeedsYou))
    sections.unshift({ group: LiveGroup.NeedsYou, rows: [] });
  if (busyPasses.length > 0 && !has(LiveGroup.Running)) {
    const at = sections.findIndex(
      (s) =>
        s.group === LiveGroup.InReview ||
        s.group === LiveGroup.Waiting ||
        s.group === LiveGroup.Done,
    );
    sections.splice(at === -1 ? sections.length : at, 0, { group: LiveGroup.Running, rows: [] });
  }

  return (
    <Stack gap="lg" className={classes['list']}>
      {retry.error === null ? null : (
        <Alert
          color="red"
          title="Couldn't retry the run"
          withCloseButton
          onClose={() => {
            retry.reset();
          }}
        >
          {retry.error.message}
        </Alert>
      )}
      {sections.map(({ group, rows }) => {
        const extra =
          group === LiveGroup.NeedsYou
            ? waitingPasses
            : group === LiveGroup.Running
              ? busyPasses
              : [];
        return (
          <Section key={group} label={LIVE_GROUP_LABELS[group]} count={rows.length + extra.length}>
            {extra.map(passRow)}
            {rows.map((ws) => (
              <Row
                key={ws.id}
                project={nameOf(ws.projectId)}
                // A finished run whose pull request is open is in review: blue, never done's green.
                dot={group === LiveGroup.InReview ? 'blue' : STATE_COLORS[ws.state]}
                title={ws.taskHeadline === '' ? ws.taskTitle : ws.taskHeadline}
                detail={group === LiveGroup.InReview ? 'Pull request open' : doing(ws)}
                when={shortAgo(lastMoment(ws), now)}
                action={
                  canRetryHere(ws) ? (
                    <Button
                      size="compact-xs"
                      variant="default"
                      loading={retry.isPending && retry.variables.id === ws.id}
                      onClick={() => {
                        retry.mutate({ id: ws.id });
                      }}
                    >
                      Retry
                    </Button>
                  ) : undefined
                }
                onOpen={() => {
                  open(ws);
                }}
              />
            ))}
          </Section>
        );
      })}
    </Stack>
  );
}
