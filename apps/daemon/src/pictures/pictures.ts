import { readFileSync } from 'node:fs';
import {
  APP_URL_IS_DAEMON,
  BrowserState,
  isDaemonAddress,
  EventType,
  NotFoundError,
  PassId,
  PassState,
  PassTurnEnding,
  PassTurnId,
  ProjectId,
  ScreenKind,
  TaskId,
  TaskMessageAuthor,
  TaskStatus,
  WorkstreamId,
  WorkstreamState,
  type AppUrl,
  type DaemonEvent,
  type PicturesStatusDto,
  type ProjectDto,
  type TaskDto,
  type TaskScreenId,
  type TaskScreensDto,
} from '@10db/contracts';
import {
  findPass,
  getPassTurn,
  getProject,
  getTask,
  getTaskScreenRow,
  getWorkstream,
  hasTaskScreen,
  insertSystemNotice,
  listLivePasses,
  listPassTasks,
  listProjects,
  listSharedChanges,
  listTasks,
  listTaskScreens,
  listTaskThread,
  listTaskToolCalls,
  listTaskTurns,
  taskStartFacts,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { EventBus, StateStore } from '../events';
import type { Git } from '../git';
import type { Logger } from '../log';
import { beforeAllowed, wroteBefore } from './before-rule';
import type { PageCamera, Shot } from './camera';
import { CAPTURE_IDLE, captureStep, type CaptureEvent, type CaptureRequest } from './capture-queue';
import { keepScreen, sweepPictureTemps, type ScreenToKeep } from './picture-files';
import { pictureRoutes, takesPictures, turnChangedSomething } from './picture-routes';
import { signIn, type SignInDeps, type SignInProject } from './sign-in';
import { readStorageState, type StorageState } from './storage-state';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10, §12: the pictures of a
// task's pages, taken by the daemon's browser through one queue. A pass page gets a before when the pass
// opens or it joins, a picture after each Ready turn that changed something, and an after at sign-off; a
// Your-folder task naming a routed page gets a before at its first launch and an after once done. Each
// capture's route, outcome, milliseconds and bytes are logged; a picture is never sent anywhere.

/** The longest a task's first launch waits for its before. */
export const BEFORE_WAIT_MS = 20_000;

/** How far back start-up looks for a finished Your-folder task whose after was missed. */
const MISSED_AFTER_MS = 60 * 60_000;

/** The start of the thread notice said once per task when a page lands elsewhere. */
export const ELSEWHERE_NOTICE = 'Pictures of this page landed on another page of the app';

export interface PicturesDeps {
  readonly state: StateStore;
  readonly bus: EventBus;
  readonly camera: PageCamera;
  /** The port the daemon's API listens on, which no app address may name; null until it listens. */
  readonly daemonPort: () => number | null;
  /** Starts fetching the pinned browser when it is not there yet; returns at once. */
  readonly prepareBrowser: () => void;
  readonly git: Pick<Git, 'head'>;
  /** The dev login's runner and environment; the camera is this service's own. */
  readonly signIn: Omit<SignInDeps, 'camera'>;
  readonly dataDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface Pictures {
  /**
   * A task's first launch: asks its before, under the before rule, and waits for it at most
   * `BEFORE_WAIT_MS`. Resolves at once for a task that takes no pictures or has started.
   */
  awaitBefore(task: TaskDto, signal: AbortSignal): Promise<void>;
  /** Settings › General's status line for a project. */
  status(projectId: ProjectId): PicturesStatusDto;
  screens(taskId: TaskId): TaskScreensDto;
  /** A picture's PNG; throws NotFoundError for a pruned or missing one. */
  screenFile(screenId: TaskScreenId): Uint8Array<ArrayBuffer>;
  /** Drops what waits, aborts the load in flight and waits for it; nothing is asked again. */
  stop(): Promise<void>;
}

/** Passes in these states hold back their afters and take no turn or before. */
const HOLDING: readonly PassState[] = [PassState.Closing, PassState.Abandoning];

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Builds the service and follows the bus; start-up's catch-up runs before it returns. */
export function startPictures(deps: PicturesDeps): Pictures {
  const db = deps.state.db;
  const log = deps.logger;
  let queue = CAPTURE_IDLE;
  let current: {
    readonly request: CaptureRequest;
    readonly abort: AbortController;
    done: Promise<void>;
  } | null = null;
  let watchingFetch = false;
  /** A task's first launch waiting on its before. */
  const beforeWaiters = new Map<TaskId, (() => void)[]>();
  const signIns = new Map<ProjectId, { problem: string | null; at: string }>();
  const appUrls = new Map<ProjectId, AppUrl | null>();
  const passStates = new Map<PassId, PassState>();

  function apply(event: CaptureEvent): void {
    const s = captureStep(queue, event);
    queue = s.queue;
    if (s.abort) current?.abort.abort();
    releaseBeforeWaiters();
  }

  /** A waiting launch goes on once no before of its task waits or loads. */
  function releaseBeforeWaiters(): void {
    for (const [taskId, waiters] of beforeWaiters) {
      if (beforePending(taskId)) continue;
      beforeWaiters.delete(taskId);
      for (const release of waiters) release();
    }
  }

  const isBeforeOf = (taskId: TaskId) => (r: CaptureRequest | null) =>
    r !== null && r.kind === ScreenKind.Before && r.taskId === taskId;
  const beforePending = (taskId: TaskId): boolean =>
    queue.waiting.some(isBeforeOf(taskId)) || isBeforeOf(taskId)(queue.loading);

  /** Follows the browser's readiness: a download holds befores back and drops the rest. */
  function syncBrowser(): void {
    const status = deps.camera.status();
    if (status.state !== queue.browser) apply({ kind: 'browser', state: status.state });
    if (status.state === BrowserState.Fetching && !watchingFetch) {
      watchingFetch = true;
      void status.ready.then(() => {
        watchingFetch = false;
        syncBrowser();
        pump();
      });
    }
  }

  function ask(request: CaptureRequest): void {
    syncBrowser();
    apply({ kind: 'ask', request });
    pump();
  }

  function pump(): void {
    if (current !== null) return;
    const s = captureStep(queue, { kind: 'start' });
    queue = s.queue;
    if (s.started === null) return;
    const request = s.started;
    const abort = new AbortController();
    const run = { request, abort, done: Promise.resolve() };
    current = run;
    let kept = 0;
    run.done = capture(request, abort.signal)
      .then((n) => {
        kept = n;
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          log.warn(
            { taskId: request.taskId, kind: request.kind, err: errorText(error) },
            'could not take a picture',
          );
      })
      .finally(() => {
        log.info(
          { taskId: request.taskId, kind: request.kind, kept, aborted: abort.signal.aborted },
          'a capture ended',
        );
        current = null;
        apply({ kind: 'done' });
        pump();
      });
  }

  /** An app address on the daemon's own port: a page there would reach 10db's API, so none is shot. */
  function onDaemon(appUrl: AppUrl): boolean {
    const port = deps.daemonPort();
    return port !== null && isDaemonAddress(appUrl, port);
  }

  /** Asks a before for the task when it takes pictures, has none, and has started nothing. */
  function askBefore(task: TaskDto, passId: PassId | null): void {
    const project = getProject(db, task.projectId);
    if (project.appUrl === null || !takesPictures(project, task)) return;
    if (pictureRoutes(project, task).length === 0) return;
    if (hasTaskScreen(db, task.id, ScreenKind.Before)) return;
    if (!beforeAllowed({ inPass: passId !== null, ...taskStartFacts(db, task.id) })) return;
    ask({ kind: ScreenKind.Before, projectId: project.id, passId, taskId: task.id, turnId: null });
  }

  function askAfter(task: TaskDto, passId: PassId | null): void {
    const project = getProject(db, task.projectId);
    if (project.appUrl === null || !takesPictures(project, task)) return;
    if (pictureRoutes(project, task).length === 0) return;
    ask({ kind: ScreenKind.After, projectId: project.id, passId, taskId: task.id, turnId: null });
  }

  async function runSignIn(
    project: SignInProject,
    signal: AbortSignal,
  ): Promise<StorageState | null> {
    const result = await signIn({ ...deps.signIn, camera: deps.camera }, project, signal);
    signIns.set(project.id, {
      problem: result.ok ? null : result.problem,
      at: deps.clock.now().toISOString(),
    });
    if (result.ok) log.info({ projectId: project.id }, 'signed the browser for pictures in');
    else
      log.warn(
        { projectId: project.id, problem: result.problem },
        'could not sign the browser for pictures in',
      );
    return result.ok ? result.state : null;
  }

  /** Says once on the task's thread that its page lands elsewhere, however many turns it does. */
  function noticeElsewhere(taskId: TaskId, route: string): void {
    const said = listTaskThread(db, taskId).some(
      (m) => m.author === TaskMessageAuthor.System && m.body.startsWith(ELSEWHERE_NOTICE),
    );
    if (said) return;
    deps.state.write((ctx) => {
      insertSystemNotice(
        ctx,
        taskId,
        `${ELSEWHERE_NOTICE} instead of ${route}, even after signing in again, so no picture of it was kept. Check the dev login command in Settings › General.`,
      );
    });
  }

  async function keptShaOf(request: CaptureRequest, project: ProjectDto): Promise<string | null> {
    if (request.turnId !== null) return getPassTurn(db, request.turnId).keptSha;
    try {
      return await deps.git.head(project.repoPath);
    } catch {
      return null;
    }
  }

  /** Takes the request's pictures and keeps them; answers how many rows it kept. */
  async function capture(request: CaptureRequest, signal: AbortSignal): Promise<number> {
    // Read as a call: an await may abort it between two reads.
    const stopped = (): boolean => signal.aborted;
    const project = getProject(db, request.projectId);
    const task = getTask(db, request.taskId);
    const appUrl = project.appUrl;
    if (appUrl === null || onDaemon(appUrl)) return 0;
    const inPass = request.passId !== null;
    if (
      request.kind === ScreenKind.Before &&
      !beforeAllowed({ inPass, ...taskStartFacts(db, task.id) })
    )
      return 0;
    const targets = pictureRoutes(project, task);
    if (targets.length === 0) return 0;
    let storageState = readStorageState(deps.dataDir, project.id);
    if (storageState === null && project.devLoginCommand !== null) {
      storageState = await runSignIn(project, signal);
      if (storageState === null) return 0;
    }
    let signedInAgain = false;
    const shots: Omit<ScreenToKeep, 'keptSha'>[] = [];
    for (const target of targets) {
      const shoot = (state: StorageState | null): Promise<Shot> =>
        deps.camera.shoot({ appUrl, ...target, storageState: state, signal });
      const startedAt = deps.clock.now().getTime();
      let shot = await shoot(storageState);
      if (shot.outcome === 'elsewhere' && project.devLoginCommand !== null && !signedInAgain) {
        signedInAgain = true;
        storageState = await runSignIn(project, signal);
        if (storageState === null) return 0;
        shot = await shoot(storageState);
      }
      if (stopped()) return 0;
      log.info(
        {
          taskId: task.id,
          kind: request.kind,
          route: target.route,
          outcome: shot.outcome,
          ms: deps.clock.now().getTime() - startedAt,
          bytes: shot.png?.length ?? 0,
        },
        'took a picture',
      );
      if (shot.outcome === 'elsewhere') {
        if (signedInAgain)
          signIns.set(project.id, {
            problem: `${target.route} landed on another page of the app after signing in`,
            at: deps.clock.now().toISOString(),
          });
        noticeElsewhere(task.id, target.route);
        continue;
      }
      if (shot.png === null || shot.outcome === 'failed') continue;
      shots.push({
        taskId: task.id,
        turnId: request.turnId,
        kind: request.kind,
        route: target.route,
        viewport: target.viewport,
        theme: target.theme,
        png: shot.png,
      });
    }
    if (stopped() || shots.length === 0) return 0;
    const keptSha = await keptShaOf(request, project);
    if (stopped()) return 0;
    const end = deps.state.now();
    if (
      request.kind === ScreenKind.Before &&
      wroteBefore(listTaskToolCalls(db, task.id, end), end)
    ) {
      log.info({ taskId: task.id }, 'dropped a before picture: the task wrote before it was taken');
      return 0;
    }
    return shots.filter(
      (screen) => keepScreen(deps.state, deps.dataDir, { ...screen, keptSha }) !== null,
    ).length;
  }

  /** The pass's state as last seen, and what moving out of it or into it means for the queue. */
  function followPass(passId: PassId): void {
    const pass = findPass(db, passId);
    if (pass === undefined) return;
    const was = passStates.get(passId);
    passStates.set(passId, pass.state);
    const holding = HOLDING.includes(pass.state);
    const held = was !== undefined && HOLDING.includes(was);
    if (holding && !held) apply({ kind: 'pass_holding', passId });
    if (!holding && held) apply({ kind: 'pass_released', passId });
    if (pass.state === PassState.Open)
      for (const task of listPassTasks(db, passId)) askBefore(task, passId);
    pump();
  }

  function onTurnReady(passId: PassId, taskId: TaskId, turnId: PassTurnId): void {
    const turn = getPassTurn(db, turnId);
    const earlier = listTaskTurns(db, taskId).filter(
      (t) => t.seq < turn.seq && t.ending === PassTurnEnding.Ready,
    );
    const previous = earlier[earlier.length - 1];
    if (!turnChangedSomething(turn, previous, listSharedChanges(db, passId))) return;
    const task = getTask(db, taskId);
    const project = getProject(db, task.projectId);
    if (project.appUrl === null) return;
    ask({ kind: ScreenKind.Turn, projectId: project.id, passId, taskId, turnId });
  }

  function onProjectChanged(projectId: ProjectId): void {
    const project = getProject(db, projectId);
    const was = appUrls.get(projectId) ?? null;
    appUrls.set(projectId, project.appUrl);
    if (was === project.appUrl) return;
    if (was !== null) apply({ kind: 'app_changed', projectId });
    if (project.appUrl !== null) deps.prepareBrowser();
    pump();
  }

  const onPass = (event: DaemonEvent): void => {
    const passId = PassId.safeParse(event.entityId);
    if (passId.success) followPass(passId.data);
  };

  /** What each event the pictures follow means for the queue. */
  const handlers: Partial<Record<EventType, (event: DaemonEvent) => void>> = {
    [EventType.PassOpened]: onPass,
    [EventType.PassChanged]: onPass,
    [EventType.PassTurnStarted]: (event) => {
      const taskId = TaskId.safeParse(event.data['taskId']);
      if (taskId.success) apply({ kind: 'turn_started', taskId: taskId.data });
    },
    // A stopped turn may have left the page half done, as a new one may.
    [EventType.PassTurnEnded]: (event) => {
      const taskId = TaskId.safeParse(event.data['taskId']);
      if (taskId.success && event.data['ending'] !== PassTurnEnding.Ready)
        apply({ kind: 'turn_started', taskId: taskId.data });
    },
    [EventType.PassPageReady]: (event) => {
      const passId = PassId.safeParse(event.entityId);
      const taskId = TaskId.safeParse(event.data['taskId']);
      const turnId = PassTurnId.safeParse(event.data['turnId']);
      if (passId.success && taskId.success && turnId.success)
        onTurnReady(passId.data, taskId.data, turnId.data);
    },
    [EventType.PassPageSignedOff]: (event) => {
      const passId = PassId.safeParse(event.data['passId']);
      const taskId = TaskId.safeParse(event.data['taskId']);
      if (!passId.success || !taskId.success) return;
      apply({ kind: 'signing_off', taskId: taskId.data });
      askAfter(getTask(db, taskId.data), passId.data);
    },
    // A task leaving its pass: a take-out, an Abandon's or a close's.
    [EventType.TaskChanged]: (event) => {
      const taskId = TaskId.safeParse(event.entityId);
      if (taskId.success && typeof event.data['leftPassId'] === 'string')
        apply({ kind: 'taken_out', taskId: taskId.data });
      pump();
    },
    [EventType.WorkstreamChanged]: (event) => {
      if (event.data['to'] !== WorkstreamState.Done || event.data['from'] === WorkstreamState.Done)
        return;
      const runId = WorkstreamId.safeParse(event.entityId);
      if (!runId.success) return;
      const task = getTask(db, getWorkstream(db, runId.data).taskId);
      if (task.passId == null) askAfter(task, null);
    },
    [EventType.ProjectChanged]: (event) => {
      const projectId = ProjectId.safeParse(event.entityId);
      if (projectId.success) onProjectChanged(projectId.data);
    },
  };

  // Start-up: what a stopped write left; the browser's fetch for a project that will need it; the pass
  // states as they stand; befores for open pages that have none; afters missed in the last hour.
  const swept = sweepPictureTemps(deps.dataDir);
  if (swept > 0) log.info({ removed: swept }, 'removed pictures a stopped write left half written');
  const projects = listProjects(db);
  for (const project of projects) appUrls.set(project.id, project.appUrl);
  if (projects.some((p) => p.appUrl !== null)) deps.prepareBrowser();
  syncBrowser();
  for (const pass of listLivePasses(db)) passStates.set(pass.id, pass.state);
  for (const pass of listLivePasses(db))
    if (pass.state === PassState.Open)
      for (const task of listPassTasks(db, pass.id)) askBefore(task, pass.id);
  const since = deps.clock.now().getTime() - MISSED_AFTER_MS;
  for (const project of projects) {
    if (project.appUrl === null) continue;
    for (const task of listTasks(db, project.id))
      if (
        task.status === TaskStatus.Done &&
        task.passId == null &&
        Date.parse(task.updatedAt) >= since &&
        !hasTaskScreen(db, task.id, ScreenKind.After)
      )
        askAfter(task, null);
  }
  const unsubscribe = deps.bus.subscribe((event) => {
    handlers[event.type]?.(event);
  });

  return {
    async awaitBefore(task, signal) {
      askBefore(task, task.passId ?? null);
      if (!beforePending(task.id)) return;
      await new Promise<void>((resolve) => {
        let timer: Timer | null = null;
        const finish = (): void => {
          timer?.cancel();
          signal.removeEventListener('abort', finish);
          resolve();
        };
        timer = deps.clock.setTimeout(finish, BEFORE_WAIT_MS);
        signal.addEventListener('abort', finish, { once: true });
        beforeWaiters.set(task.id, [...(beforeWaiters.get(task.id) ?? []), finish]);
      });
    },
    status(projectId) {
      const { appUrl } = getProject(db, projectId);
      if (appUrl !== null && onDaemon(appUrl))
        return {
          browser: { state: BrowserState.Refused, problem: APP_URL_IS_DAEMON },
          signIn: signIns.get(projectId) ?? null,
        };
      const browser = deps.camera.status();
      return {
        browser: { state: browser.state, problem: browser.problem },
        signIn: signIns.get(projectId) ?? null,
      };
    },
    screens(taskId) {
      getTask(db, taskId);
      return { taskId, screens: listTaskScreens(db, taskId), fromGoal: [] };
    },
    screenFile(screenId) {
      const row = getTaskScreenRow(db, screenId);
      if (row.prunedAt !== null) throw new NotFoundError('task screen', screenId);
      try {
        return readFileSync(row.storedPath);
      } catch {
        throw new NotFoundError('task screen', screenId);
      }
    },
    async stop() {
      unsubscribe();
      apply({ kind: 'shutdown' });
      await current?.done;
    },
  };
}
