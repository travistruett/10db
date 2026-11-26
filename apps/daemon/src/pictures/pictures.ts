import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  APP_URL_IS_DAEMON,
  BatchId,
  BatchState,
  BrowserState,
  isDaemonAddress,
  EventType,
  NotFoundError,
  PassId,
  PassState,
  PassTurnEnding,
  REPORTED_ROUTES_MAX,
  PassTurnId,
  ProjectId,
  ScreenKind,
  ScreenTheme,
  TaskId,
  TaskMessageAuthor,
  TaskStatus,
  WorkstreamId,
  WorkstreamState,
  type AppUrl,
  type DaemonEvent,
  type DesignCheckId,
  type TaskDesignCheckDto,
  type DesignCheckPurpose,
  type PicturesStatusDto,
  type ProjectDto,
  type ScreenViewport,
  type TaskDto,
  type TaskScreenDto,
  type TaskScreenId,
  type TaskScreensDto,
} from '@10db/contracts';
import {
  findPass,
  getBatch,
  getDesignCheck,
  latestWorkstreamOf,
  latestTaskDesignChecks,
  getPassTurn,
  getProject,
  getTask,
  getTaskScreenRow,
  getWorkstream,
  hasTaskScreen,
  insertSystemNotice,
  isLocalCopy,
  listBatches,
  listLivePasses,
  listPassTasks,
  listProjects,
  listSharedChanges,
  listTasks,
  listTaskScreens,
  listTaskThread,
  listGoalRouteScreens,
  listTaskCodexStarts,
  latestPassTurn,
  listTaskPageReports,
  listTaskToolCalls,
  listWorkstreams,
  listTaskTurns,
  openPassTurn,
  openPreviewMark,
  taskStartFacts,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { EventBus, StateStore } from '../events';
import type { Git } from '../git';
import type { Logger } from '../log';
import { beforeAllowed, wroteBefore, type TaskActivity } from './before-rule';
import type { PageCamera, Shot } from './camera';
import { CAPTURE_IDLE, captureStep, type CaptureEvent, type CaptureRequest } from './capture-queue';
import {
  keepScreen,
  picturePath,
  pngSize,
  sweepPictureTemps,
  writePicture,
  type ScreenToKeep,
} from './picture-files';
import { taskInLocalCopy } from './copy-task';
import { keptRoute, pageAreaRoutes } from './kept-route';
import {
  pageRoute,
  pageRouteLoads,
  pictureRoutes,
  takesPictures,
  turnChangedSomething,
} from './picture-routes';
import { judgePreview, routeLoad, type RouteShot } from './preview-marks';
import { signIn, sweepLoginLogs, type SignInDeps, type SignInProject } from './sign-in';
import { signInRecordOf, type SignInReporter } from './sign-in-record';
import { forgetStorageState, readStorageState, type StorageState } from './storage-state';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10, §12: the pictures of a
// task's pages, taken by the daemon's browser through one queue. A pass page gets a before when the pass
// opens or it joins, a picture after each Ready turn that changed something, and an after at sign-off; a
// Your-folder task naming a routed page gets a before at its first launch and an after once done. Each
// capture's route, outcome, milliseconds and bytes are logged; a picture is never sent anywhere.

/** The longest a task's first launch waits for its before. */
const BEFORE_WAIT_MS = 20_000;

/** How long a refused browser fetch rests before the next ask tries it again. */
const FETCH_RETRY_MS = 10 * 60_000;

/** How far back start-up looks for a finished Your-folder task whose after was missed. */
export const MISSED_AFTER_MS = 60 * 60_000;

/** The start of the thread notice said once per task when a page lands elsewhere. */
const ELSEWHERE_NOTICE = 'Pictures of this page landed on another page of the app';

/** A page shot on demand: its PNG's hash and where it lies. */
export interface NowShot {
  readonly route: string;
  readonly viewport: ScreenViewport;
  readonly theme: ScreenTheme;
  readonly sha256: string;
  readonly path: string;
}

/** What `shootNow` answers: the pages it shot, and what it could not shoot and why. */
export interface ShotsNow {
  /** The window and theme every shot was taken in. */
  readonly viewport: ScreenViewport;
  readonly theme: ScreenTheme;
  readonly shots: readonly NowShot[];
  /** A route that was not shot, or null for all of them (no app address, nothing answering). */
  readonly missing: readonly { readonly route: string | null; readonly reason: string }[];
}

export interface ShootNowInput {
  readonly projectId: ProjectId;
  readonly routes: readonly string[];
  /** Why the pictures are wanted, for the log. */
  readonly purpose: DesignCheckPurpose;
  /** Told what the preview would show in a pass header, when it starts with no pass open. */
  readonly say?: (line: string) => void;
}

/** A mock-up drawn: its PNG's hash and where it lies, or why it could not be. */
export type MockupDrawn =
  { readonly sha256: string; readonly path: string } | { readonly missing: string };

export interface PicturesDeps {
  readonly state: StateStore;
  readonly bus: EventBus;
  readonly camera: PageCamera;
  /**
   * The port the daemon's API listens on, which no app address may name; settles once it listens.
   * No picture is taken before then.
   */
  readonly daemonPort: Promise<number>;
  /** Starts fetching the pinned browser when it is not there yet; returns at once. */
  readonly prepareBrowser: () => void;
  readonly git: Pick<Git, 'head'>;
  /** The dev login's runner and environment; the camera is this service's own. */
  readonly signIn: Omit<SignInDeps, 'camera'>;
  /** Where a failed or successful sign-in is told: the project's card and the record its updates read. */
  readonly signInReporter: SignInReporter;
  readonly dataDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Told when a load found nothing answering at a project 10db runs the preview of. */
  readonly onNoAnswer?: (projectId: ProjectId) => void;
  /**
   * Told when an after picture's capture for a task outside a pass ended without being stopped, with
   * whatever rows it kept, so a finished task's pictures can be shared.
   */
  readonly onAfterCapture?: (taskId: TaskId) => void;
  /**
   * 10db's own dev UI: the browser origin the daemon trusts as it, and its read-only token. A shot of
   * an app at that origin is handed the token and may read the daemon, since the dev UI draws nothing
   * without it; null when the daemon trusts no dev UI.
   */
  readonly devUi: { readonly origin: string; readonly token: string } | null;
  /**
   * Keeps the project's app up for an on-demand shot (renewed before each route) and says whether it
   * answers, else why not; absent, the shot goes ahead at whatever answers.
   */
  readonly holdApp?: (
    projectId: ProjectId,
    say?: (line: string) => void,
  ) => Promise<{ readonly up: true } | { readonly up: false; readonly why: string }>;
}

/** An on-demand picture was asked of, or overtaken by, a daemon that is stopping. */
export class PicturesStoppedError extends Error {
  override readonly name = 'PicturesStoppedError';
  constructor() {
    super('The daemon is stopping, so no picture is taken.');
  }
}

/**
 * What a task's after picture can still be expected to do, for the updates that show it:
 * - `none`: the task names no page, already has its pictures, or nothing says they were skipped;
 * - `wait`: a capture of its after is waiting or running, so its answer is not in yet;
 * - `later`: a local copy whose change has not landed, so its after is taken then;
 * - `skipped`: no picture was or will be taken, and why (a sentence with no full stop).
 */
export type PicturesOutlook =
  | { readonly kind: 'none' | 'wait' | 'later' }
  | { readonly kind: 'skipped'; readonly reason: string };

export interface Pictures {
  /**
   * A task's first launch: asks its before, under the before rule, and waits for it at most
   * `BEFORE_WAIT_MS`. Resolves at once for a task that takes no pictures or has started.
   */
  awaitBefore(task: TaskDto, signal: AbortSignal): Promise<void>;
  /** Settings › App Preview's status line for a project. */
  status(projectId: ProjectId): PicturesStatusDto;
  /** What a task that names a page can still expect of its after picture; see `PicturesOutlook`. */
  outlook(taskId: TaskId): PicturesOutlook;
  /**
   * Shots of the routes as they are now, for a design check: the first viewport and theme of the
   * project's matrix, signed in as a capture is, one at a time with every other capture. Nothing is
   * kept as a task picture; a check keeps the files.
   */
  shootNow(input: ShootNowInput): Promise<ShotsNow>;
  /** Draws a mock-up's HTML in the first viewport and theme of the project's matrix, cached by what it drew. */
  drawMockup(projectId: ProjectId, html: string): Promise<MockupDrawn>;
  /** The size of a kept picture's file by its hash; 0 when there is none. */
  bytesOf(sha256: string): number;
  screens(taskId: TaskId): TaskScreensDto;
  /** The task's newest design check. */
  designCheck(taskId: TaskId): TaskDesignCheckDto;
  /** A design check's mock-up PNG or the PNG of its shot at a position; NotFoundError when it has none. */
  designCheckFile(checkId: DesignCheckId, part: 'mockup' | number): Uint8Array<ArrayBuffer>;
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
  /** A task's routes that landed elsewhere even after a fresh sign-in: no sign-in again for them. */
  const redirectingRoutes = new Set<string>();
  const appUrls = new Map<ProjectId, AppUrl | null>();
  const devLogins = new Map<ProjectId, string | null>();
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

  /** When the browser's fetch was last asked for, by the clock. */
  let preparedAt: number | null = null;

  function prepareBrowser(): void {
    preparedAt = deps.clock.now().getTime();
    deps.prepareBrowser();
  }

  /** A refused fetch is tried again once it has rested, or at once when a pass opens. */
  function retryRefusedFetch(now: boolean): void {
    if (deps.camera.status().state !== BrowserState.Refused) return;
    const rested = preparedAt === null || deps.clock.now().getTime() - preparedAt >= FETCH_RETRY_MS;
    if (now || rested) prepareBrowser();
  }

  function ask(request: CaptureRequest): void {
    retryRefusedFetch(false);
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
        if (request.kind === ScreenKind.After && request.passId === null && !abort.signal.aborted) {
          try {
            deps.onAfterCapture?.(request.taskId);
          } catch (error) {
            log.warn(
              { taskId: request.taskId, err: errorText(error) },
              'after capture not announced',
            );
          }
        }
        pump();
      });
  }

  /** The daemon's API port once it listens; null before. */
  let listenPort: number | null = null;
  void deps.daemonPort.then((port) => {
    listenPort = port;
  });

  /** An app address on the daemon's own port: a page there would reach 10db's API, so none is shot. */
  const onDaemon = (appUrl: AppUrl, port: number): boolean => isDaemonAddress(appUrl, port);

  /** The project's app address as it stands, unless it names the daemon's own port. */
  function shootableAddress(projectId: ProjectId, port: number): AppUrl | null {
    const { appUrl } = getProject(db, projectId);
    return appUrl === null || onDaemon(appUrl, port) ? null : appUrl;
  }

  /** The daemon's address and token for a shot of 10db's own dev UI; null for every other app. */
  function devUiFor(appUrl: AppUrl, port: number): { url: string; token: string } | null {
    return deps.devUi !== null && URL.parse(appUrl)?.origin === deps.devUi.origin
      ? { url: `http://127.0.0.1:${String(port)}`, token: deps.devUi.token }
      : null;
  }

  /** What the task's sessions did up to `until`, as the before rule reads it. */
  const activityOf = (taskId: TaskId, until: string): TaskActivity => ({
    calls: listTaskToolCalls(db, taskId, until),
    codexStarts: listTaskCodexStarts(db, taskId),
  });

  const inLocalCopy = (task: TaskDto): boolean => taskInLocalCopy(db, task.id);

  /** Asks an after for each task of a shipped local copy that has none. */
  function askCopyAfters(batchId: BatchId): void {
    for (const run of listWorkstreams(db, { batchId })) {
      const task = getTask(db, run.taskId);
      if (!hasTaskScreen(db, task.id, ScreenKind.After)) askAfter(task, null);
    }
  }

  /** Asks a before for the task when it takes pictures, has none, and has started nothing. */
  function askBefore(task: TaskDto, passId: PassId | null): void {
    const project = getProject(db, task.projectId);
    if (project.appUrl === null || !takesPictures(project, task, [], inLocalCopy(task))) return;
    if (pictureRoutes(project, task).length === 0) return;
    if (hasTaskScreen(db, task.id, ScreenKind.Before)) return;
    if (!beforeAllowed({ inPass: passId !== null, ...taskStartFacts(db, task.id) })) return;
    // A before taken now would be dropped at its end: the task has written already.
    const now = deps.state.now();
    if (wroteBefore(activityOf(task.id, now), now)) return;
    ask({ kind: ScreenKind.Before, projectId: project.id, passId, taskId: task.id, turnId: null });
  }

  /**
   * The pictures a goal's task opens with (spec §4.2): for each other task of its goal, the newest
   * after on this task's page route, else its newest before; oldest first.
   */
  function goalPictures(taskId: TaskId): TaskScreenDto[] {
    const task = getTask(db, taskId);
    if (task.goalId == null) return [];
    const route = pageRoute(getProject(db, task.projectId), task);
    if (route === null) return [];
    const best = new Map<TaskId, TaskScreenDto>();
    for (const screen of listGoalRouteScreens(db, task.goalId, route)) {
      if (screen.taskId === taskId) continue;
      const held = best.get(screen.taskId);
      if (held === undefined || screen.kind === ScreenKind.After || held.kind === ScreenKind.Before)
        best.set(screen.taskId, screen);
    }
    return [...best.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * The routes the task's agent reported for a picture of `kind`: a turn picture's are its turn's; a
   * pass page's after takes its last turn's, any other task's after its run's. Each is matched again
   * against the project's page areas as they are now, so a route whose page area went is not loaded.
   */
  function reportedFor(
    kind: ScreenKind,
    task: TaskDto,
    turnId: PassTurnId | null,
    inPass: boolean,
  ): string[] {
    const lastTurn = inPass ? latestPassTurn(db, task.id) : undefined;
    const rows =
      kind === ScreenKind.Turn && turnId !== null
        ? listTaskPageReports(db, { taskId: task.id, turnId })
        : kind !== ScreenKind.After
          ? []
          : lastTurn !== undefined
            ? listTaskPageReports(db, { taskId: task.id, turnId: lastTurn.id })
            : !inPass && task.workstreamId !== null
              ? listTaskPageReports(db, { taskId: task.id, workstreamId: task.workstreamId })
              : [];
    const areaRoutes = pageAreaRoutes(getProject(db, task.projectId).areas);
    const kept = rows.flatMap((r) => keptRoute(areaRoutes, r.route) ?? []);
    return [...new Set(kept)].slice(0, REPORTED_ROUTES_MAX);
  }

  function askAfter(task: TaskDto, passId: PassId | null): void {
    const project = getProject(db, task.projectId);
    const reported = reportedFor(ScreenKind.After, task, null, passId !== null);
    if (project.appUrl === null || !takesPictures(project, task, reported, inLocalCopy(task)))
      return;
    if (pictureRoutes(project, task, reported).length === 0) return;
    ask({ kind: ScreenKind.After, projectId: project.id, passId, taskId: task.id, turnId: null });
  }

  async function runSignIn(
    project: SignInProject,
    signal: AbortSignal,
  ): Promise<StorageState | null> {
    const result = await signIn({ ...deps.signIn, camera: deps.camera }, project, signal);
    // A login stopped with its capture says nothing of the project's sign-in.
    if (signal.aborted) return null;
    signIns.set(project.id, {
      problem: result.ok ? null : result.problem,
      at: deps.clock.now().toISOString(),
    });
    const at = deps.clock.now().toISOString();
    try {
      if (result.ok) deps.signInReporter.succeeded(project.id);
      else deps.signInReporter.failed(project.id, result.problem, result.failure, at);
    } catch (error) {
      log.warn({ projectId: project.id, err: errorText(error) }, 'a picture sign-in not recorded');
    }
    if (result.ok) log.info({ projectId: project.id }, 'signed the browser for pictures in');
    else
      log.warn(
        { projectId: project.id, problem: result.problem },
        'could not sign the browser for pictures in',
      );
    return result.ok ? result.state : null;
  }

  /** Says once on the task's thread that its page lands elsewhere, however many turns it does. */
  function noticeElsewhere(taskId: TaskId, route: string, signedIn: boolean): void {
    const said = listTaskThread(db, taskId).some(
      (m) => m.author === TaskMessageAuthor.System && m.body.startsWith(ELSEWHERE_NOTICE),
    );
    if (said) return;
    deps.state.write((ctx) => {
      insertSystemNotice(
        ctx,
        taskId,
        signedIn
          ? `${ELSEWHERE_NOTICE} instead of ${route}, even after signing in again, so no picture of it was kept. Check the dev login command in Settings › App Preview.`
          : `${ELSEWHERE_NOTICE} instead of ${route}, so no picture of it was kept. If the page needs a sign-in, set a dev login command in Settings › App Preview.`,
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
    // A shutdown before the API listens ends the wait.
    const port = await Promise.race([
      deps.daemonPort,
      new Promise<null>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve(null);
        });
        if (signal.aborted) resolve(null);
      }),
    ]);
    if (port === null || stopped()) return 0;
    const appUrl = shootableAddress(project.id, port);
    if (appUrl === null) return 0;
    const inPass = request.passId !== null;
    if (
      request.kind === ScreenKind.Before &&
      !beforeAllowed({ inPass, ...taskStartFacts(db, task.id) })
    )
      return 0;
    const targets = pictureRoutes(
      project,
      task,
      reportedFor(request.kind, task, request.turnId, request.passId !== null),
    );
    if (targets.length === 0) return 0;
    let storageState = readStorageState(deps.dataDir, project.id);
    if (storageState === null && project.devLoginCommand !== null) {
      if (shootableAddress(project.id, port) !== appUrl) return 0;
      storageState = await runSignIn(project, signal);
      if (storageState === null) return 0;
    }
    let signedInAgain = false;
    const shots: Omit<ScreenToKeep, 'keptSha'>[] = [];
    const judged = pageRoute(project, task);
    const loads: RouteShot[] = [];
    const devUi = devUiFor(appUrl, port);
    for (const target of targets) {
      const shoot = (state: StorageState | null): Promise<Shot> =>
        shootableAddress(project.id, port) === appUrl
          ? deps.camera.shoot({ appUrl, ...target, storageState: state, devUi, signal })
          : Promise.reject(new Error("The app address changed or names 10db's own port"));
      const startedAt = deps.clock.now().getTime();
      let shot = await shoot(storageState);
      const redirects = `${task.id} ${target.route}`;
      if (
        shot.outcome === 'elsewhere' &&
        project.devLoginCommand !== null &&
        !signedInAgain &&
        !redirectingRoutes.has(redirects)
      ) {
        signedInAgain = true;
        if (shootableAddress(project.id, port) !== appUrl) return 0;
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
      if (target.route === judged)
        loads.push({
          outcome: shot.outcome,
          overlayText: shot.overlayText,
          reason: shot.reason,
          cameraFailed: shot.cameraFailed,
        });
      if (shot.outcome === 'elsewhere') {
        if (signedInAgain) {
          // Still elsewhere after a fresh sign-in: the route redirects by design for this task.
          redirectingRoutes.add(redirects);
          signIns.set(project.id, {
            problem: `${target.route} landed on another page of the app after signing in`,
            at: deps.clock.now().toISOString(),
          });
        }
        noticeElsewhere(task.id, target.route, project.devLoginCommand !== null);
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
    if (stopped()) return 0;
    const end = deps.state.now();
    if (request.kind === ScreenKind.Before && wroteBefore(activityOf(task.id, end), end)) {
      log.info({ taskId: task.id }, 'dropped a before picture: the task wrote before it was taken');
      return 0;
    }
    const load = judged === null ? null : routeLoad(judged, loads);
    if (request.passId !== null && load !== null)
      judgePreview(
        {
          state: deps.state,
          logger: log,
          ...(deps.onNoAnswer ? { onNoAnswer: deps.onNoAnswer } : {}),
        },
        {
          passId: request.passId,
          taskId: task.id,
          kind: request.kind,
          turnId: request.turnId,
          load,
        },
      );
    if (shots.length === 0) return 0;
    const keptSha = await keptShaOf(request, project);
    if (stopped()) return 0;
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
    // A page already in its next turn may be half changed: its picture would show half a turn.
    if (openPassTurn(db, taskId) !== undefined) return;
    const turn = getPassTurn(db, turnId);
    const earlier = listTaskTurns(db, taskId).filter(
      (t) => t.seq < turn.seq && t.ending === PassTurnEnding.Ready,
    );
    const previous = earlier[earlier.length - 1];
    // A page that broke the preview is shot after every Ready turn, changed or not: only a clean load of
    // its route can mend its mark, and the break may have been fixed elsewhere.
    if (
      !turnChangedSomething(turn, previous, listSharedChanges(db, passId)) &&
      openPreviewMark(db, passId, taskId) === undefined
    )
      return;
    const task = getTask(db, taskId);
    const project = getProject(db, task.projectId);
    if (project.appUrl === null) return;
    ask({ kind: ScreenKind.Turn, projectId: project.id, passId, taskId, turnId });
  }

  function onProjectChanged(projectId: ProjectId): void {
    const project = getProject(db, projectId);
    const was = appUrls.get(projectId) ?? null;
    const loginWas = devLogins.get(projectId) ?? null;
    appUrls.set(projectId, project.appUrl);
    devLogins.set(projectId, project.devLoginCommand);
    // A sign-in kept for another address or another dev login is not this one's, and neither is its failure.
    if (was !== project.appUrl || loginWas !== project.devLoginCommand) {
      forgetStorageState(deps.dataDir, projectId);
      try {
        deps.signInReporter.succeeded(projectId);
      } catch (error) {
        log.warn({ projectId, err: errorText(error) }, 'a picture sign-in failure not withdrawn');
      }
    }
    if (was === project.appUrl) return;
    if (was !== null) apply({ kind: 'app_changed', projectId });
    if (project.appUrl !== null) {
      prepareBrowser();
      // The open pages' befores are taken at the new address, under the before rule.
      for (const pass of listLivePasses(db))
        if (pass.projectId === projectId && pass.state === PassState.Open)
          for (const task of listPassTasks(db, pass.id)) askBefore(task, pass.id);
    }
    pump();
  }

  const onPass = (event: DaemonEvent): void => {
    const passId = PassId.safeParse(event.entityId);
    if (passId.success) followPass(passId.data);
  };

  /** What each event the pictures follow means for the queue. */
  const handlers: Partial<Record<EventType, (event: DaemonEvent) => void>> = {
    [EventType.PassOpened]: (event) => {
      const projectId = ProjectId.safeParse(event.data['projectId']);
      if (projectId.success && getProject(db, projectId.data).appUrl !== null)
        retryRefusedFetch(true);
      onPass(event);
    },
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
      const run = getWorkstream(db, runId.data);
      // A copy task's after waits for its batch to ship: only then is its change in the copy.
      if (run.batchId !== null && isLocalCopy(db, run.batchId)) return;
      const task = getTask(db, run.taskId);
      if (task.passId == null) askAfter(task, null);
    },
    [EventType.BatchUpdated]: (event) => {
      if (event.data['to'] !== BatchState.Shipped) return;
      const batchId = BatchId.safeParse(event.entityId);
      if (batchId.success && isLocalCopy(db, batchId.data)) askCopyAfters(batchId.data);
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
  const logs = sweepLoginLogs(deps.dataDir);
  if (logs > 0) log.info({ removed: logs }, 'removed dev login logs a stopped daemon left');
  // Every project, archived included: a restored project keeps its saved sign-in.
  const projects = listProjects(db);
  for (const project of projects) {
    appUrls.set(project.id, project.appUrl);
    devLogins.set(project.id, project.devLoginCommand);
  }
  if (projects.some((p) => p.archivedAt === null && p.appUrl !== null)) prepareBrowser();
  syncBrowser();
  // A pass a restart finds closing or being abandoned holds its afters back, as it did before.
  for (const pass of listLivePasses(db)) {
    passStates.set(pass.id, pass.state);
    if (HOLDING.includes(pass.state)) apply({ kind: 'pass_holding', passId: pass.id });
  }
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
        !inLocalCopy(task) &&
        Date.parse(task.updatedAt) >= since &&
        !hasTaskScreen(db, task.id, ScreenKind.After)
      )
        askAfter(task, null);
  }
  for (const batch of listBatches(db, { states: [BatchState.Shipped] }))
    if (Date.parse(batch.updatedAt) >= since && isLocalCopy(db, batch.id)) askCopyAfters(batch.id);
  const unsubscribe = deps.bus.subscribe((event) => {
    handlers[event.type]?.(event);
  });

  /** Mock-ups drawn since start, by what was drawn (HTML, viewport, theme): the PNG's hash. */
  const drawnMockups = new Map<string, string>();
  /** On-demand draws and shots under way, aborted by `stop`. */
  const nowRuns = new Set<AbortController>();
  let stopping = false;
  /** An on-demand run begins only while the service runs, and its answer is dropped once it stops. */
  const whileRunning = (): void => {
    if (stopping) throw new PicturesStoppedError();
  };

  /** The first viewport and theme of the project's matrix: what an on-demand picture is taken in. */
  function firstOfMatrix(project: ProjectDto): { viewport: ScreenViewport; theme: ScreenTheme } {
    const [viewport] = project.screens.viewports;
    const [theme] = project.screens.themes;
    return {
      viewport: viewport ?? { width: 1440, height: 900 },
      theme: theme ?? ScreenTheme.Default,
    };
  }

  async function drawMockup(projectId: ProjectId, html: string): Promise<MockupDrawn> {
    whileRunning();
    const { viewport, theme } = firstOfMatrix(getProject(db, projectId));
    const key = createHash('sha256')
      .update(JSON.stringify([html, viewport, theme]))
      .digest('hex');
    const known = drawnMockups.get(key);
    if (known !== undefined && existsSync(picturePath(deps.dataDir, known)))
      return { sha256: known, path: picturePath(deps.dataDir, known) };
    const abort = new AbortController();
    nowRuns.add(abort);
    try {
      const drawn = await deps.camera.drawHtml({ html, viewport, theme, signal: abort.signal });
      if (drawn.png === null || drawn.outcome !== 'clean')
        return { missing: drawn.reason ?? 'the mock-up could not be drawn' };
      if (pngSize(drawn.png) === null)
        return { missing: 'the browser answered a picture that is not a PNG' };
      const file = writePicture(deps.dataDir, drawn.png);
      drawnMockups.set(key, file.sha256);
      return { sha256: file.sha256, path: file.storedPath };
    } catch (error) {
      if (error instanceof PicturesStoppedError) throw error;
      return { missing: abort.signal.aborted ? 'the daemon is stopping' : errorText(error) };
    } finally {
      nowRuns.delete(abort);
      whileRunning();
    }
  }

  /** Why a shot that is not clean gives the design review nothing, in a line. */
  function missingReason(shot: Shot): string {
    switch (shot.outcome) {
      case 'overlay':
        return `the app shows its error overlay: ${shot.overlayText ?? 'no text'}`;
      case 'elsewhere':
        return 'the page lands on another page of the app (a sign-in, perhaps): set a dev login command in Settings › App Preview';
      case 'no_answer':
        return 'the app did not answer';
      case 'clean':
      case 'failed':
        return shot.reason ?? 'the page could not be shot';
    }
  }

  async function shootNow(input: ShootNowInput): Promise<ShotsNow> {
    whileRunning();
    const project = getProject(db, input.projectId);
    const { viewport, theme } = firstOfMatrix(project);
    const none = (reason: string): ShotsNow => ({
      viewport,
      theme,
      shots: [],
      missing: [{ route: null, reason }],
    });
    const asked = [...new Set(input.routes)];
    const routes = asked.filter(pageRouteLoads);
    const unloadable = asked
      .filter((r) => !pageRouteLoads(r))
      .map((route) => ({
        route,
        reason: 'the route has a parameter, so there is no page to load',
      }));
    if (routes.length === 0) return { viewport, theme, shots: [], missing: unloadable };
    if (project.appUrl === null) return none('the project has no app address');
    const port = listenPort ?? (await deps.daemonPort);
    const appUrl = shootableAddress(project.id, port);
    if (appUrl === null) return none("the app address is 10db's own port");
    const abort = new AbortController();
    nowRuns.add(abort);
    try {
      if (deps.holdApp) {
        const held = await deps.holdApp(project.id, input.say);
        if (!held.up) return none(held.why);
      }
      const devUi = devUiFor(appUrl, port);
      let storageState = readStorageState(deps.dataDir, project.id);
      if (storageState === null && project.devLoginCommand !== null)
        storageState = await runSignIn(project, abort.signal);
      let signedInAgain = false;
      const shots: NowShot[] = [];
      const missing: { route: string | null; reason: string }[] = [...unloadable];
      for (const route of routes) {
        // A long review renews the hold before each shot, so its preview is not taken away part-way.
        if (deps.holdApp) {
          const held = await deps.holdApp(project.id, input.say);
          if (!held.up) {
            missing.push({ route, reason: held.why });
            continue;
          }
        }
        const shoot = (state: StorageState | null): Promise<Shot> =>
          deps.camera.shoot({
            appUrl,
            route,
            viewport,
            theme,
            storageState: state,
            devUi,
            signal: abort.signal,
          });
        const startedAt = deps.clock.now().getTime();
        let shot = await shoot(storageState);
        if (shot.outcome === 'elsewhere' && project.devLoginCommand !== null && !signedInAgain) {
          signedInAgain = true;
          storageState = await runSignIn(project, abort.signal);
          if (storageState !== null) shot = await shoot(storageState);
        }
        log.info(
          {
            projectId: project.id,
            purpose: input.purpose,
            route,
            outcome: shot.outcome,
            ms: deps.clock.now().getTime() - startedAt,
            bytes: shot.png?.length ?? 0,
          },
          'took a picture now',
        );
        if (shot.outcome === 'clean' && shot.png !== null && pngSize(shot.png) !== null) {
          const file = writePicture(deps.dataDir, shot.png);
          shots.push({ route, viewport, theme, sha256: file.sha256, path: file.storedPath });
        } else missing.push({ route, reason: missingReason(shot) });
      }
      return { viewport, theme, shots, missing };
    } catch (error) {
      if (error instanceof PicturesStoppedError) throw error;
      return none(abort.signal.aborted ? 'the daemon is stopping' : errorText(error));
    } finally {
      nowRuns.delete(abort);
      whileRunning();
    }
  }

  return {
    shootNow,
    drawMockup,
    bytesOf(sha256) {
      try {
        return statSync(picturePath(deps.dataDir, sha256)).size;
      } catch {
        return 0;
      }
    },
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
    outlook(taskId) {
      const task = getTask(db, taskId);
      const project = getProject(db, task.projectId);
      if (project.appUrl === null) return { kind: 'none' };
      const reported = reportedFor(ScreenKind.After, task, null, task.passId != null);
      if (pictureRoutes(project, task, reported).length === 0) return { kind: 'none' };
      if (hasTaskScreen(db, taskId, ScreenKind.After)) return { kind: 'none' };
      const localCopy = inLocalCopy(task);
      if (!takesPictures(project, task, reported, localCopy))
        return {
          kind: 'skipped',
          reason:
            'The task ran in a separate copy of the project, and 10db takes pictures only of tasks in Your folder, in a local copy or on a page of a pass',
        };
      // A local copy's after is taken once its change is in the project.
      const batchId = localCopy ? (latestWorkstreamOf(db, taskId)?.batchId ?? null) : null;
      if (batchId !== null && getBatch(db, batchId).state !== BatchState.Shipped)
        return { kind: 'later' };
      const asked = (r: CaptureRequest | null): boolean =>
        r !== null && r.kind === ScreenKind.After && r.taskId === taskId;
      if (queue.waiting.some(asked) || asked(queue.loading)) return { kind: 'wait' };
      const failed = signInRecordOf(db, project.id);
      if (failed !== null) return { kind: 'skipped', reason: failed.problem };
      const browser = deps.camera.status();
      return browser.state === BrowserState.Refused
        ? { kind: 'skipped', reason: `The pictures browser is not available (${browser.problem})` }
        : { kind: 'none' };
    },
    status(projectId) {
      const { appUrl } = getProject(db, projectId);
      if (appUrl !== null && listenPort !== null && onDaemon(appUrl, listenPort))
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
      return { taskId, screens: listTaskScreens(db, taskId), fromGoal: goalPictures(taskId) };
    },
    designCheck(taskId) {
      getTask(db, taskId);
      return { taskId, checks: latestTaskDesignChecks(db, taskId) };
    },
    designCheckFile(checkId, part) {
      const check = getDesignCheck(db, checkId);
      const sha = part === 'mockup' ? check.mockupSha256 : (check.shots[part]?.sha256 ?? null);
      if (sha === null) throw new NotFoundError('design check picture', checkId);
      try {
        return readFileSync(picturePath(deps.dataDir, sha));
      } catch {
        throw new NotFoundError('design check picture', checkId);
      }
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
      stopping = true;
      unsubscribe();
      apply({ kind: 'shutdown' });
      for (const abort of nowRuns) abort.abort();
      await current?.done;
    },
  };
}
