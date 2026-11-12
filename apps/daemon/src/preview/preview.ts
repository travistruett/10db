import { join } from 'node:path';
import {
  EventType,
  PassNoticeKind,
  ProjectId,
  type DaemonEvent,
  type PassDto,
  type PassId,
  type PermissionRuleDto,
  type ProjectDto,
} from '@10db/contracts';
import {
  clearPassNotice,
  findOpenPass,
  getPassProgress,
  getProject,
  listLivePasses,
  setPassNotice,
} from '@10db/db';
import type { EventBus, StateStore } from '../events';
import type { Logger } from '../log';
import type { GateResult, GateRunner } from '../verify';
import { openPreviewLedger, type PreviewLedger, type PreviewLedgers } from './preview-ledger';
import { answers as defaultAnswers } from './probe';
import { RESTART_WINDOW_MS, RESTARTS_IN_WINDOW, restartsLeft } from './restart-budget';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: while a project has a live pass
// and a preview command, 10db runs the command under the gate's sandbox, unless something answers at
// the app address already; it restarts it a few times, and the pass header says only what needs a
// look: that it is starting, or that it stopped.

/** The header's one notice about the preview command; a later one replaces it. */
const NOTICE_ID = 'preview-server';
/** The longest a timer can wait: the preview runs until it is stopped, with no timeout of its own. */
const NO_TIMEOUT_MS = 2 ** 31 - 1;
/** The output lines a stopped preview's notice keeps. */
const TAIL_LINES = 20;

export interface PreviewTiming {
  /** The pause before a preview that exited is started again. */
  readonly restartAfterMs: number;
  /** How long a started preview may take to answer before the header says it doesn't yet. */
  readonly answerWithinMs: number;
  /** How often a starting preview's address is looked at. */
  readonly probeEveryMs: number;
  /** How long a stopped preview's command may take to exit before its tree is ended without it. */
  readonly stopWithinMs: number;
}

const DEFAULT_TIMING: PreviewTiming = {
  restartAfterMs: 2_000,
  answerWithinMs: 120_000,
  probeEveryMs: 1_000,
  stopWithinMs: 10_000,
};

export interface PreviewDeps {
  readonly state: StateStore;
  readonly bus: EventBus;
  /** The unslotted gate runner, as the dev login's: the preview runs under the gate's sandbox. */
  readonly gate: GateRunner;
  readonly dataDir: string;
  readonly sessionEnv: () => Readonly<Record<string, string>>;
  readonly rules: (
    project: ProjectDto,
  ) => readonly Pick<PermissionRuleDto, 'toolName' | 'pattern'>[];
  readonly checkouts: () => readonly string[];
  readonly logger: Logger;
  /** Where its processes are remembered for a later start to reap; null keeps no ledger. */
  readonly ledgers?: PreviewLedgers | null;
  /** Whether anything answers at an address; a real look by default. */
  readonly answers?: (appUrl: string) => Promise<boolean>;
  readonly timing?: Partial<PreviewTiming>;
}

export interface Preview {
  /** Starts or stops the project's preview to match its pass and settings. */
  ensure(projectId: ProjectId): Promise<void>;
  /**
   * A picture found nothing answering at the app address: starts the preview when none runs, and
   * says so, with Restart Preview, when one runs that answered before and answers no more.
   */
  lost(projectId: ProjectId): Promise<void>;
  /** Restart Preview: forgets the exits that stopped it and starts it again. */
  restart(projectId: ProjectId): Promise<void>;
  /** Stops every preview and follows nothing more. */
  stop(): Promise<void>;
}

interface Run {
  readonly command: string;
  readonly appUrl: string;
  readonly abort: AbortController;
  /** Settles once the command exited and its ledger let go. */
  readonly done: Promise<void>;
  readonly ledger: PreviewLedger | null;
  /** Whether the app has answered since this run started. */
  readonly seen: { answered: boolean };
}

const tailOf = (output: string): string => output.trim().split('\n').slice(-TAIL_LINES).join('\n');

export function startPreview(deps: PreviewDeps): Preview {
  const { db } = deps.state;
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const answers = deps.answers ?? defaultAnswers;
  const log = deps.logger;
  const runs = new Map<ProjectId, Run>();
  const exits = new Map<ProjectId, number[]>();
  /** The command that used up its restarts: it stays stopped until Restart or a new command. */
  const gaveUp = new Map<ProjectId, string>();
  /** The pass each project's notice was last written on, so it is cleared there once that pass ends. */
  const noticedOn = new Map<ProjectId, PassId>();
  /** Each project's reconciles run one at a time. */
  const queues = new Map<ProjectId, Promise<void>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const life = { stopping: false };
  /** Read through a call, so a check after an await sees what stop() set meanwhile. */
  const stopped = (): boolean => life.stopping;

  function notice(pass: PassDto, kind: PassNoticeKind, text: string): void {
    noticedOn.set(pass.projectId, pass.id);
    const current = getPassProgress(db, pass.id).notices.find((n) => n.id === NOTICE_ID);
    if (current?.kind === kind && current.text === text) return;
    deps.state.write((ctx) => {
      setPassNotice(ctx, pass.id, {
        id: NOTICE_ID,
        kind,
        text,
        sendable: false,
        cardId: null,
        at: ctx.now,
      });
    });
  }

  /** Takes the notice off the pass it is on, open or not: an ended pass's header keeps none either. */
  function clearOn(passId: PassId): void {
    if (!getPassProgress(db, passId).notices.some((n) => n.id === NOTICE_ID)) return;
    deps.state.write((ctx) => clearPassNotice(ctx, passId, NOTICE_ID));
  }

  function clearNotice(projectId: ProjectId): void {
    const passId = noticedOn.get(projectId) ?? findOpenPass(db, projectId)?.id;
    noticedOn.delete(projectId);
    if (passId !== undefined) clearOn(passId);
  }

  function later(fn: () => void, ms: number): void {
    // A real timer on purpose: it paces a real child process, as the gate's own timeout does.
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  }

  function enqueue(projectId: ProjectId, work: () => Promise<void>): Promise<void> {
    const next = (queues.get(projectId) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      log.error({ projectId, err: error }, 'the preview could not be reconciled');
    });
    queues.set(projectId, next);
    return next;
  }

  async function end(projectId: ProjectId): Promise<void> {
    const run = runs.get(projectId);
    if (run === undefined) return;
    runs.delete(projectId);
    run.abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      run.done.then(() => true),
      new Promise<boolean>((resolve) => {
        // A real timer on purpose: it bounds a real child process.
        timer = setTimeout(() => {
          resolve(false);
        }, timing.stopWithinMs);
      }),
    ]);
    clearTimeout(timer);
    if (!exited) {
      // A descendant in a group of its own can hold the command's output open, so its exit never
      // comes: the ledger ends the whole tree it saw instead, and nothing waits on it any longer.
      await run.ledger?.end();
      log.warn({ projectId }, 'the preview did not exit in time; its processes were ended');
      return;
    }
    log.info({ projectId }, 'the preview was stopped');
  }

  /**
   * Looks at the address until the preview answers, then clears the notice. Past the deadline a
   * starting preview's notice says nothing answers yet; `sayLate` false keeps the notice as it is.
   */
  function watchAnswer(
    projectId: ProjectId,
    appUrl: string,
    run: Run,
    startedAt: number,
    sayLate = true,
  ): void {
    later(() => {
      if (runs.get(projectId) !== run || run.abort.signal.aborted) return;
      void answers(appUrl).then((up) => {
        if (runs.get(projectId) !== run || run.abort.signal.aborted) return;
        if (up) {
          run.seen.answered = true;
          clearNotice(projectId);
          log.info({ projectId }, 'the preview answers');
          return;
        }
        if (sayLate && Date.now() - startedAt > timing.answerWithinMs) {
          const pass = findOpenPass(db, projectId);
          if (pass)
            notice(
              pass,
              PassNoticeKind.PreviewStarting,
              `The preview is running, but nothing answers at ${appUrl} yet: check that \`${run.command}\` serves that address.`,
            );
        }
        // Still looked at after the deadline: a slow first build answers late, and the notice goes then.
        watchAnswer(projectId, appUrl, run, startedAt, sayLate);
      });
    }, timing.probeEveryMs);
  }

  function onExit(projectId: ProjectId, run: Run, result: GateResult | null): void {
    if (runs.get(projectId) !== run) return;
    runs.delete(projectId);
    if (run.abort.signal.aborted || life.stopping) return;
    const now = Date.now();
    const seen = [...(exits.get(projectId) ?? []), now].filter(
      (at) => now - at <= RESTART_WINDOW_MS,
    );
    exits.set(projectId, seen);
    log.warn({ projectId, exitCode: result?.exitCode ?? null }, 'the preview exited');
    if (restartsLeft(seen, now)) {
      later(() => void ensure(projectId), timing.restartAfterMs);
      return;
    }
    gaveUp.set(projectId, run.command);
    log.warn({ projectId }, 'the preview stopped for good');
    const pass = findOpenPass(db, projectId);
    if (pass === undefined) return;
    const tail = result === null ? '' : tailOf(result.tail);
    notice(
      pass,
      PassNoticeKind.PreviewStopped,
      `The preview stopped: \`${run.command}\` exited ${String(RESTARTS_IN_WINDOW + 1)} times in 10 minutes.${tail === '' ? '' : `\n${tail}`}`,
    );
  }

  function launch(project: ProjectDto, command: string, appUrl: string): void {
    const pass = findOpenPass(db, project.id);
    if (pass === undefined) return;
    notice(pass, PassNoticeKind.PreviewStarting, `Starting the preview: \`${command}\``);
    const abort = new AbortController();
    let ledger: PreviewLedger | null = null;
    if (deps.ledgers) {
      ledger = openPreviewLedger(deps.ledgers, (failure, error) => {
        log.warn({ projectId: project.id, failure, err: error }, 'the preview ledger failed');
      });
    }
    const held = ledger;
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const run: Run = { command, appUrl, abort, done, ledger: held, seen: { answered: false } };
    runs.set(project.id, run);
    log.info({ projectId: project.id }, 'the preview started');
    const finish = async (result: GateResult | null): Promise<void> => {
      await held?.end();
      onExit(project.id, run, result);
      settle();
    };
    deps.gate
      .run({
        // No project id, as the dev login's run: 10db never turns the project's Docker on for it.
        project: {
          repoPath: project.repoPath,
          sandboxLoopback: project.sandboxLoopback,
          sandboxDocker: project.sandboxDocker,
        },
        command,
        logPath: join(deps.dataDir, 'preview', `${project.id}.log`),
        timeoutMs: NO_TIMEOUT_MS,
        env: deps.sessionEnv(),
        rules: deps.rules(project),
        checkouts: deps.checkouts(),
        signal: abort.signal,
        onSpawn: (pid) => {
          void held?.track(pid);
        },
      })
      .then(finish, (error: unknown) => {
        log.error({ projectId: project.id, err: error }, 'the preview could not run');
        return finish(null);
      });
    watchAnswer(project.id, appUrl, run, Date.now());
  }

  async function reconcile(projectId: ProjectId): Promise<void> {
    if (life.stopping) return;
    let project: ProjectDto | undefined;
    try {
      project = getProject(db, projectId);
    } catch {
      // A project removed since: its preview has nothing to serve.
      project = undefined;
    }
    const pass = project ? findOpenPass(db, projectId) : undefined;
    const command = project?.previewCommand ?? null;
    const appUrl = project?.appUrl ?? null;
    if (project === undefined || pass === undefined || command === null || appUrl === null) {
      await end(projectId);
      clearNotice(projectId);
      return;
    }
    const run = runs.get(projectId);
    if (run?.command === command) return;
    if (run) await end(projectId);
    if (gaveUp.has(projectId)) {
      if (gaveUp.get(projectId) === command) {
        // The builder's own dev server answering makes the stopped notice moot.
        if (await answers(appUrl)) clearNotice(projectId);
        return;
      }
      gaveUp.delete(projectId);
      exits.delete(projectId);
    }
    if (!project.sandboxLoopback) {
      notice(
        pass,
        PassNoticeKind.PreviewStopped,
        `The preview needs Allow loopback in Project Settings › General: \`${command}\` serves ${appUrl}, and the gate's sandbox lets nothing listen without it.`,
      );
      return;
    }
    if (await answers(appUrl)) {
      clearNotice(projectId);
      log.info({ projectId }, 'something answers at the app address already');
      return;
    }
    if (stopped()) return;
    launch(project, command, appUrl);
  }

  function ensure(projectId: ProjectId): Promise<void> {
    return enqueue(projectId, () => reconcile(projectId));
  }

  const projectOf = (event: DaemonEvent): ProjectId | null => {
    const parsed = ProjectId.safeParse(
      event.type === EventType.ProjectChanged ? event.entityId : event.data['projectId'],
    );
    return parsed.success ? parsed.data : null;
  };

  const unsubscribe = deps.bus.subscribe((event) => {
    if (
      event.type !== EventType.PassOpened &&
      event.type !== EventType.PassChanged &&
      event.type !== EventType.ProjectChanged
    )
      return;
    const projectId = projectOf(event);
    if (projectId === null) return;
    // A new pass starts with a fresh allowance of restarts.
    if (event.type === EventType.PassOpened) {
      gaveUp.delete(projectId);
      exits.delete(projectId);
    }
    void ensure(projectId);
  });

  // What a stopped daemon said about its previews is stale: each is looked at afresh.
  for (const pass of listLivePasses(db)) {
    clearOn(pass.id);
    void ensure(pass.projectId);
  }

  return {
    ensure,
    lost(projectId) {
      return enqueue(projectId, async () => {
        const run = runs.get(projectId);
        if (run === undefined) {
          await reconcile(projectId);
          return;
        }
        if (!run.seen.answered || (await answers(run.appUrl))) return;
        const pass = findOpenPass(db, projectId);
        if (pass === undefined || runs.get(projectId) !== run) return;
        notice(
          pass,
          PassNoticeKind.PreviewStopped,
          `The preview runs, but it doesn't answer at ${run.appUrl} any more: Restart Preview starts it again.`,
        );
        // A dev server that restarts itself answers again: the notice goes once it does.
        run.seen.answered = false;
        watchAnswer(projectId, run.appUrl, run, Date.now(), false);
      });
    },
    async restart(projectId) {
      await enqueue(projectId, async () => {
        gaveUp.delete(projectId);
        exits.delete(projectId);
        await end(projectId);
      });
      await ensure(projectId);
    },
    async stop() {
      life.stopping = true;
      unsubscribe();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await Promise.all([...runs.keys()].map((projectId) => end(projectId)));
    },
  };
}
