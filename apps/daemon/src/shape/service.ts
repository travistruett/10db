import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConflictError,
  EventType,
  InvalidError,
  NotFoundError,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeOrigin,
  ShapeProposalState,
  shapeFileKind,
  SessionMode,
  type DecisionId,
  type Effort,
  type GoalId,
  type ProjectId,
  type ShapeDto,
  type ShapeFileDto,
  type ShapeFindingId,
  type ShapeId,
  type ShapeMessageDto,
  type ShapeMessageId,
  type ShapeProposalId,
  type ShapeViewDto,
  type SessionId,
  type StartShapeInput,
} from '@10db/contracts';
import {
  countShapeFiles,
  endSession,
  findShapeLinkOfGoal,
  getOneWayPaths,
  getProject,
  getShape,
  getShapeFinding,
  getShapeProposal,
  listRehearsals,
  getShapeSdkSessionId,
  insertSession,
  insertShape,
  insertShapeFile,
  insertShapeMessage,
  listShapeFiles,
  listShapeMessages,
  listShapes,
  listUntoldShapeFiles,
  markSessionStarted,
  markShapeFilesTold,
  patchShape,
  setOneWayPaths as setOneWayPathsRow,
  settleOpenQuestionsOfTask,
  updateSessionUsage,
  type ShapeFileRow,
  type WriteContext,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { AccountExpectation } from '../environment';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { mintSessionToken, type ShapeToolsFor } from '../mcp';
import type {
  SessionAdapter,
  SessionEvent,
  ShapeImage,
  ShapeSessionHandle,
  ShapeSessionSpec,
  TurnResult,
} from '../sessions';
import {
  effectiveOneWayPaths,
  gitTrackedFiles,
  oneWayNamesOf,
  type TrackedFiles,
} from './ceremony';
import { judgeShapeCall, researchLine, type ShapeAccess } from './confinement';
import { convertProposals, type ConvertOutcome } from './convert';
import { buildDigest } from './digest';
import { asImage, checkDroppedFile, storeFile } from './dropped-files';
import { dropNote, editNote, restoreNote, rowLabel, unpinNote } from './edit-notes';
import {
  proposeNote,
  rehearseNote,
  SHAPE_AGENTS,
  SHAPE_ALLOWED_TOOLS,
  SHAPE_BUILT_IN_TOOLS,
  SHAPE_DISALLOWED_TOOLS,
  SHAPE_SYSTEM_PROMPT,
} from './policy';
import {
  dismissFinding as dismissRow,
  editedTaskKeys,
  unrehearsedTasks,
  type RehearsalTask,
} from './review';
import {
  dropProposal as dropRow,
  editProposal as editRow,
  restoreProposal as restoreRow,
  unpinProposal as unpinRow,
} from './rounds';
import type { ShapeJev } from './jev';
import { createShapeToolHandlers } from './tools';
import { removeDraftGoalOf, withdrawConvertedDecision } from './undo';
import { convertedStateLines } from './converted-state';
import { buildShapeView, fileDtoOf, type ViewWorld } from './view';

// Shape spec §5.1, §5.3, §6, §11. Runs each conversation's session: one turn at a time, a queue, the
// Propose and Convert guards, the move to a fresh session when the context fills, and the idle close.

/** What a conversation's session launches with: the project's checkout and the `plan` role's model. */
export interface ShapeLaunch {
  readonly cwd: string;
  readonly model: string;
  readonly effort: Effort;
  readonly env: Readonly<Record<string, string>>;
  readonly account: AccountExpectation;
  readonly access: ShapeAccess;
}

export interface ShapeServiceDeps {
  readonly state: StateStore;
  readonly adapter: SessionAdapter;
  readonly clock: Clock;
  readonly log: Logger;
  readonly mcp: { readonly url: string; readonly toolTimeoutMs: number };
  /** Resolves a project's launch; throws when its account can't start a session. */
  launch(projectId: ProjectId): ShapeLaunch;
  /** Where each conversation's dropped files are kept: `<filesDir>/<shape>/files/`. */
  readonly filesDir: string;
  /** How long a session idles before its process closes; 10 minutes. */
  readonly idleMs?: number;
  /** The share of the context window past which a conversation moves to a fresh session; 70. */
  readonly contextLimitPct?: number;
  /** Jev's shadow decisions, told of each builder message (§9); it asks only for a project that opted in. */
  readonly jev?: ShapeJev;
  /** The files git tracks in a checkout, for the ceremony rule's one-way paths (§7); `git ls-files` by default. */
  readonly trackedFiles?: TrackedFiles;
}

/** A file as the input hands it over: the name and type the browser reported, and its bytes. */
export interface DroppedFile {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ShapeService {
  create(projectId: ProjectId, input: { title: string; origin: ShapeOrigin }): ShapeDto;
  /**
   * `start_shape` (spec §5.6): a conversation from a terminal session, its summary the builder's first
   * message and its text files kept. Starts no turn.
   */
  startFromTerminal(input: StartShapeInput): ShapeDto;
  /**
   * Keeps a dropped file (§5.4) and sends it with the next message: an image as an image block, any
   * other file as a line naming its path. Throws InvalidError, naming the file, when it is refused.
   */
  addFile(shapeId: ShapeId, file: DroppedFile): ShapeFileDto;
  /**
   * The builder's actions on a row (§6 Editing). Each is one write and reaches the next turn as a note.
   * Throws NotFoundError for a row of another conversation and ConflictError for a converted or dropped one.
   */
  editProposal(
    shapeId: ShapeId,
    id: ShapeProposalId,
    fields: Readonly<Record<string, unknown>>,
  ): void;
  unpinProposal(shapeId: ShapeId, id: ShapeProposalId, field?: string): void;
  restoreProposal(shapeId: ShapeId, id: ShapeProposalId): void;
  dropProposal(shapeId: ShapeId, id: ShapeProposalId): void;
  /** Records a builder message and queues its turn. */
  send(shapeId: ShapeId, text: string): ShapeMessageDto;
  /** Queues a Propose turn, or ignores the press while a Propose turn is queued or running. */
  propose(shapeId: ShapeId): { status: 'started' | 'ignored' };
  /**
   * Rehearse (spec §7): queues a turn in which the session has the rehearsal reviewer read each
   * proposed task that has no mark at its current hash, narrowed to `proposalIds` when given. Opening
   * the Convert modal asks for it too. `nothing` when every task has its mark; `running` when a
   * rehearsal turn is already queued or running.
   */
  rehearse(
    shapeId: ShapeId,
    proposalIds?: readonly ShapeProposalId[],
  ): { status: 'started' | 'running' | 'nothing'; tasks: number };
  /**
   * Reopens a conversation with an event as a note (spec §12): the note is a transcript row a
   * proposal may cite, and with each converted row's current state it reaches the next turn. Starts no
   * turn. Throws NotFoundError for an unknown conversation.
   */
  resume(shapeId: ShapeId, event: string): ShapeMessageDto;
  /**
   * The project's one-way paths (§7) in force: what the builder set, else the 10db defaults that this
   * project has. `setOneWayPaths` replaces them (an empty list included) and answers what is in force.
   */
  oneWayPaths(projectId: ProjectId): string[];
  setOneWayPaths(projectId: ProjectId, paths: readonly string[]): string[];
  /** The builder dismisses a finding or a rehearsal question, with a one-line reason. */
  dismissFinding(shapeId: ShapeId, findingId: ShapeFindingId, how?: string): void;
  /** Interrupts the turn that is running; the queue runs next. */
  stop(shapeId: ShapeId): Promise<void>;
  /** Everything the screen renders for the conversation, with where its session is. */
  view(shapeId: ShapeId): ShapeViewDto;
  /** The project's conversations, the one touched last first. */
  list(projectId: ProjectId): ShapeDto[];
  /**
   * Remove Draft Goal (spec §11), found through the conversation that made the goal. Throws
   * InvalidError for a goal no conversation made and ConflictError once a task has started.
   */
  removeDraftGoal(goalId: GoalId): void;
  /** Withdraw Decision…: a decision the conversation wrote, with the builder's reason. */
  withdrawDecision(shapeId: ShapeId, decisionId: DecisionId, reason: string): void;
  /**
   * Converts the selected proposals. Refused with a `ConflictError` while a turn runs, unless the
   * caller asks to interrupt it. Holds the queue while it writes.
   */
  convert(
    shapeId: ShapeId,
    proposalIds: readonly ShapeProposalId[],
    options?: { interrupt?: boolean },
  ): Promise<ConvertOutcome>;
  /** The handlers the MCP endpoint serves a conversation's session. */
  readonly toolsFor: ShapeToolsFor;
  /** Resolves when no turn is running or queued. */
  settled(shapeId: ShapeId): Promise<void>;
  /** Stops every session. */
  close(): Promise<void>;
}

/** A conversation's name until its first message gives it one. */
export const DEFAULT_SHAPE_TITLE = 'New conversation';
const TITLE_MAX = 60;

/** The first non-empty line of a message, cut to fit a title. */
function titleFrom(text: string): string {
  const line = (text.split('\n').find((l) => l.trim() !== '') ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

const IDLE_MS = 10 * 60_000;
/** How long a checkout's tracked files are reused before git is asked again. */
const TRACKED_FILES_TTL_MS = 30_000;
const CONTEXT_LIMIT_PCT = 70;

interface Turn {
  readonly kind: 'message' | 'propose' | 'rehearse';
  /** What the session is sent, with the id of the message it answers. */
  readonly prompt: string;
  /** The transcript row the turn answers; builder messages before it are context a fresh session lacks. */
  readonly messageId: ShapeMessageId;
  /** A rehearsal turn: the tasks it was told to read, each at the hash it listed. */
  readonly rehearsing?: readonly Pick<RehearsalTask, 'taskKey' | 'hash'>[];
}

/** What goes ahead of a turn's message: the builder's edits since the last turn and the files dropped. */
interface Intake {
  readonly notes: readonly string[];
  readonly files: readonly ShapeFileRow[];
}

type TurnEnd =
  | { readonly kind: 'complete'; readonly result: TurnResult | undefined }
  | { readonly kind: 'ended' };

interface Live {
  readonly handle: ShapeSessionHandle;
  readonly sessionId: SessionId;
  /** Why the daemon ended it, when it did; the session's exit reason otherwise comes from Claude Code. */
  endReason: string | null;
  /** Resolves when its events have ended: the session has ended and its row says so. */
  done: Promise<void>;
}

interface Runtime {
  readonly queue: Turn[];
  /** The builder's edits not yet told to Claude; they go ahead of the next turn. */
  readonly notes: string[];
  current: Turn | null;
  live: Live | null;
  /** Resolves the running turn, when the session says it ended. */
  waiting: ((end: TurnEnd) => void) | null;
  /** Set while Convert writes: no new turn starts. */
  held: boolean;
  pump: Promise<void> | null;
  idle: Timer | null;
  contextPct: number;
  /** Whether the turn running now has had an accepted propose_plan call, and how many were refused. */
  proposed: boolean;
  refused: number;
  /** Stop or Convert interrupted the turn running now. */
  interrupted: boolean;
  /**
   * Resolves when the session the daemon last closed has ended. No new session starts before it,
   * so two processes never run, or resume the same SDK session, at once.
   */
  closing: Promise<void> | null;
}

export function createShapeService(deps: ShapeServiceDeps): ShapeService {
  const { state, adapter, clock, log } = deps;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const contextLimit = deps.contextLimitPct ?? CONTEXT_LIMIT_PCT;
  const runtimes = new Map<ShapeId, Runtime>();

  const runtimeOf = (shapeId: ShapeId): Runtime => {
    let rt = runtimes.get(shapeId);
    if (rt === undefined) {
      rt = {
        queue: [],
        notes: [],
        current: null,
        live: null,
        waiting: null,
        held: false,
        pump: null,
        idle: null,
        contextPct: 0,
        proposed: false,
        refused: 0,
        interrupted: false,
        closing: null,
      };
      runtimes.set(shapeId, rt);
    }
    return rt;
  };

  const say = (
    shapeId: ShapeId,
    author: ShapeMessageAuthor,
    kind: ShapeMessageKind,
    body: string,
  ): ShapeMessageDto =>
    state.write((ctx) => insertShapeMessage(ctx, shapeId, { author, kind, body }));
  const notice = (shapeId: ShapeId, body: string): void => {
    say(shapeId, ShapeMessageAuthor.Note, ShapeMessageKind.Notice, body);
  };

  /** Tells the screen the conversation changed, for what no row records (where its session is). */
  const announce = (shapeId: ShapeId): void => {
    state.write((ctx) => {
      ctx.emit({
        type: EventType.ShapeChanged,
        entityType: 'shape',
        entityId: shapeId,
        data: { projectId: getShape(ctx.tx, shapeId).projectId },
      });
    });
  };

  // What the ceremony rule reads about a project: the files git tracks, kept for a short while so the
  // screen refreshing on every transcript line doesn't list a large repository each time.
  const trackedFiles = deps.trackedFiles ?? gitTrackedFiles;
  const tracked = new Map<string, { readonly at: number; readonly files: readonly string[] }>();
  const trackedOf = (repoPath: string): readonly string[] => {
    const now = clock.now().getTime();
    let held = tracked.get(repoPath);
    if (held === undefined || now - held.at > TRACKED_FILES_TTL_MS) {
      held = { at: now, files: trackedFiles(repoPath) };
      tracked.set(repoPath, held);
    }
    return held.files;
  };
  const oneWayPathsOf = (projectId: ProjectId): string[] =>
    effectiveOneWayPaths(
      getOneWayPaths(state.db, projectId),
      trackedOf(getProject(state.db, projectId).repoPath),
    );
  const worldOf = (projectId: ProjectId): ViewWorld => {
    const project = getProject(state.db, projectId);
    return {
      oneWayNames: oneWayNamesOf({
        tracked: trackedOf(project.repoPath),
        globs: oneWayPathsOf(projectId),
        areas: project.areas,
        hazards: project.hazards,
      }),
    };
  };
  const worldOfShape = (shapeId: ShapeId): ViewWorld =>
    worldOf(getShape(state.db, shapeId).projectId);

  const toolsFor: ShapeToolsFor = ({ shapeId }) =>
    createShapeToolHandlers(
      {
        state,
        world: worldOfShape,
        onProposal: (id, accepted) => {
          const rt = runtimeOf(id);
          if (accepted) rt.proposed = true;
          else rt.refused += 1;
        },
      },
      shapeId,
    );

  /**
   * One builder action on a row, as one write with its transcript note: whichever of this and a
   * reconcile lands second sees the other. The note reaches Claude ahead of the next turn.
   */
  const builderAction = (
    shapeId: ShapeId,
    id: ShapeProposalId,
    act: (ctx: WriteContext, label: string) => string | null,
  ): void => {
    const note = state.write((ctx) => {
      const row = getShapeProposal(ctx.tx, id);
      if (row.shapeId !== shapeId) throw new NotFoundError('shape proposal', id);
      const text = act(ctx, rowLabel(row));
      if (text !== null)
        insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Note,
          kind: ShapeMessageKind.Edit,
          body: text,
        });
      return text;
    });
    if (note !== null) runtimeOf(shapeId).notes.push(note);
  };

  // --- Events from a session --------------------------------------------------------------------

  const onEvent = (shapeId: ShapeId, rt: Runtime, live: Live, event: SessionEvent): void => {
    // A session the daemon has closed still records its own row, but it no longer runs the
    // conversation: its events never end the turn of the session that replaced it.
    const running = rt.live === live;
    switch (event.type) {
      case 'started':
        state.write((ctx) => {
          markSessionStarted(ctx, live.sessionId, event.providerSessionId, event.pid);
          patchShape(ctx, shapeId, { sdkSessionId: event.providerSessionId });
        });
        break;
      case 'context':
        rt.contextPct = event.percentage;
        state.write((ctx) => {
          updateSessionUsage(ctx, live.sessionId, { contextPct: event.percentage });
        });
        break;
      case 'turn_complete':
        state.write((ctx) => {
          updateSessionUsage(ctx, live.sessionId, {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cachedTokens: event.cachedTokens,
            costUsd: event.costUsd,
          });
          // The reply and the usage land together: a turn the transcript shows is a turn counted.
          if (event.text !== undefined && event.text !== '')
            insertShapeMessage(ctx, shapeId, {
              author: ShapeMessageAuthor.Claude,
              kind: ShapeMessageKind.Text,
              body: event.text,
            });
        });
        if (running) rt.waiting?.({ kind: 'complete', result: event.result });
        break;
      case 'rate_limit':
        if (event.status === 'rejected')
          notice(
            shapeId,
            event.resetsAt === null
              ? 'Claude is rate limited; try again later.'
              : `Claude is rate limited until ${event.resetsAt.toISOString()}; try again then.`,
          );
        break;
      case 'ended':
        state.write((ctx) => {
          endSession(ctx, live.sessionId, live.endReason ?? event.reason);
        });
        if (running) rt.live = null;
        if (live.endReason === null && event.reason !== 'completed' && event.reason !== 'stopped')
          notice(shapeId, event.message ?? `Claude's session ended (${event.reason}).`);
        if (running) rt.waiting?.({ kind: 'ended' });
        break;
      case 'activity':
      case 'compacted':
      case 'background_tasks':
        break;
    }
  };

  const consume = async (shapeId: ShapeId, rt: Runtime, live: Live): Promise<void> => {
    try {
      for await (const event of live.handle.events) onEvent(shapeId, rt, live, event);
    } catch (error) {
      log.error({ err: error, shapeId }, 'shape session events failed');
    }
  };

  // --- Starting a session -----------------------------------------------------------------------

  /** The lines that tell Claude what the builder did since it last heard: edits, then files. */
  const intakeText = (intake: Intake): string =>
    [
      ...intake.notes.map((note) => `[note] ${note}`),
      ...intake.files.map((file) => `[file] ${file.storedPath} (${file.name})`),
    ].join('\n');

  /** The dropped images among the files, read from where the daemon keeps them. */
  const imagesOf = (files: readonly ShapeFileRow[]): ShapeImage[] =>
    files.flatMap((file) => {
      try {
        const kind = shapeFileKind(file.name);
        const image = kind === null ? null : asImage(kind, readFileSync(file.storedPath));
        return image === null ? [] : [image];
      } catch (error) {
        log.warn({ err: error, file: file.name }, 'a dropped image could not be read');
        return [];
      }
    });

  /**
   * Takes what has gathered for the conversation's next turn. Which files Claude has not been told
   * about is read from the database, so a file dropped before a restart still reaches it.
   */
  const takeIntake = (shapeId: ShapeId, rt: Runtime): Intake => ({
    notes: rt.notes.splice(0),
    files: listUntoldShapeFiles(state.db, shapeId),
  });

  /** Records that the turn just sent carried these files. */
  const told = (files: readonly ShapeFileRow[]): void => {
    state.write((ctx) => {
      markShapeFilesTold(
        ctx,
        files.map((f) => f.id),
      );
    });
  };

  /** Starts the conversation's session with `prompt` as its first message. */
  const start = (shapeId: ShapeId, rt: Runtime, turn: Turn, intake: Intake): void => {
    const shape = getShape(state.db, shapeId);
    const launch = deps.launch(shape.projectId);
    const resumeId = getShapeSdkSessionId(state.db, shapeId);
    const transcript = listShapeMessages(state.db, shapeId);
    const parts: string[] = [];
    // No session to resume, and Claude has spoken: a session that lost it starts from the digest,
    // which is stored so what it saw is on record.
    const spoken = transcript.some(
      (m) => m.author === ShapeMessageAuthor.Claude && m.kind === ShapeMessageKind.Text,
    );
    if (resumeId === null && spoken) {
      const digest = buildDigest(state.db, shapeId);
      say(shapeId, ShapeMessageAuthor.Note, ShapeMessageKind.Digest, digest);
      parts.push(digest);
    }
    // A session that never heard the conversation (a start_shape summary, or earlier messages whose
    // session never started) is told what the builder has said so far, and about every file.
    let files = intake.files;
    if (resumeId === null) {
      if (!spoken)
        parts.push(
          ...transcript
            .filter(
              (m) =>
                m.author === ShapeMessageAuthor.Builder &&
                m.kind === ShapeMessageKind.Text &&
                m.id < turn.messageId,
            )
            .map((m) => `[m:${m.id}] ${m.body}`),
        );
      files = listShapeFiles(state.db, shapeId);
    }
    const lines = intakeText({ notes: intake.notes, files });
    if (lines !== '') parts.push(lines);
    parts.push(turn.prompt);
    const prompt = parts.join('\n\n');
    const images = imagesOf(intake.files);
    const { token, hash } = mintSessionToken();
    const row = state.write((ctx) =>
      insertSession(ctx, {
        shapeId,
        provider: adapter.provider,
        model: launch.model,
        effort: launch.effort,
        mode: SessionMode.Managed,
        mcpTokenHash: hash,
      }),
    );
    const spec: ShapeSessionSpec = {
      sessionId: row.id,
      shapeId,
      cwd: launch.cwd,
      systemPrompt: SHAPE_SYSTEM_PROMPT,
      prompt,
      ...(images.length === 0 ? {} : { images }),
      model: launch.model,
      effort: launch.effort,
      resumeProviderSessionId: resumeId,
      env: launch.env,
      account: launch.account,
      tools: [...SHAPE_BUILT_IN_TOOLS],
      allowedTools: SHAPE_ALLOWED_TOOLS,
      disallowedTools: [...SHAPE_DISALLOWED_TOOLS],
      agents: SHAPE_AGENTS,
      mcp: { url: deps.mcp.url, token, toolTimeoutMs: deps.mcp.toolTimeoutMs },
      preToolUse: (req) => {
        const verdict = judgeShapeCall(
          {
            toolName: req.toolName,
            toolInput: req.input,
            agentId: req.agentId,
            agentType: req.agentType,
          },
          launch.access,
        );
        if (verdict.decision === 'deny')
          say(
            shapeId,
            ShapeMessageAuthor.Claude,
            ShapeMessageKind.Tool,
            `${req.toolName} · refused · ${verdict.reason}`,
          );
        else {
          // Research (§5.2): the question and every search and fetch shows, so the builder sees
          // what left the machine.
          const line = researchLine(req.toolName, req.input);
          if (line !== null) say(shapeId, ShapeMessageAuthor.Claude, ShapeMessageKind.Tool, line);
        }
        return verdict;
      },
    };
    const live: Live = {
      handle: adapter.startShape(spec),
      sessionId: row.id,
      endReason: null,
      done: Promise.resolve(),
    };
    rt.live = live;
    told(files);
    live.done = consume(shapeId, rt, live);
  };

  /** Stops the running session; resolves, as `rt.closing` does, once it has ended. */
  const closeLive = (rt: Runtime, reason: string): Promise<void> => {
    const live = rt.live;
    if (live === null) return rt.closing ?? Promise.resolve();
    live.endReason = reason;
    rt.live = null;
    // A turn waiting on this session ends with it: its own `ended` event no longer counts.
    rt.waiting?.({ kind: 'ended' });
    const previous = rt.closing;
    const closing = (async () => {
      try {
        await live.handle.stop();
      } catch (error) {
        log.warn({ err: error, sessionId: live.sessionId }, 'shape session did not stop cleanly');
      }
      await live.done;
      await previous;
    })();
    rt.closing = closing;
    void closing.finally(() => {
      if (rt.closing === closing) rt.closing = null;
    });
    return closing;
  };

  const armIdle = (rt: Runtime): void => {
    rt.idle?.cancel();
    rt.idle = clock.setTimeout(() => {
      rt.idle = null;
      if (rt.current !== null || rt.queue.length > 0 || rt.held) return;
      void closeLive(rt, 'idle');
    }, idleMs);
  };

  // --- Turns ------------------------------------------------------------------------------------

  const runTurn = async (shapeId: ShapeId, rt: Runtime, turn: Turn): Promise<void> => {
    rt.idle?.cancel();
    rt.idle = null;
    rt.proposed = false;
    rt.refused = 0;
    rt.interrupted = false;
    // The turn counts as running (rt.current) while the last session finishes closing.
    if (rt.live === null && rt.closing !== null) await rt.closing;
    const ended = new Promise<TurnEnd>((resolve) => {
      rt.waiting = resolve;
    });
    const intake = takeIntake(shapeId, rt);
    try {
      if (rt.live === null) start(shapeId, rt, turn, intake);
      else {
        const lines = intakeText(intake);
        rt.live.handle.send(
          lines === '' ? turn.prompt : `${lines}\n\n${turn.prompt}`,
          imagesOf(intake.files),
        );
        told(intake.files);
      }
    } catch (error) {
      // The turn never reached Claude, so what was to go ahead of it waits for the next one; its
      // files were never marked told.
      rt.notes.unshift(...intake.notes);
      rt.waiting = null;
      log.warn({ err: error, shapeId }, 'shape session could not start');
      notice(
        shapeId,
        `Claude could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const end = await ended;
    rt.waiting = null;
    // Read through a function: Stop sets the flag while the turn is awaited, which narrowing misses.
    const stopped = (): boolean => rt.interrupted;
    const proposedIn = (): boolean => rt.proposed;
    const failed = end.kind === 'complete' && end.result === 'error' && !stopped();
    if (failed) notice(shapeId, "Claude's turn failed; send the message again.");
    if (end.kind === 'complete' && !failed && !stopped() && turn.kind === 'propose') {
      if (!proposedIn()) {
        log.info({ shapeId, refusedProposals: rt.refused }, 'a propose turn proposed nothing');
        notice(shapeId, "Claude didn't propose; Propose Again");
      }
    }
    // A task the turn listed and got no closing report for stays "Not rehearsed": never read as clean.
    if (end.kind === 'complete' && !failed && !stopped() && turn.kind === 'rehearse') {
      const marked = new Set(
        listRehearsals(state.db, shapeId).map((m) => `${m.taskKey}\0${m.hash}`),
      );
      const skipped = (turn.rehearsing ?? []).filter((t) => !marked.has(`${t.taskKey}\0${t.hash}`));
      if (skipped.length > 0)
        notice(
          shapeId,
          `The rehearsal didn't read ${String(skipped.length)} of ${String(turn.rehearsing?.length ?? 0)} ${(turn.rehearsing?.length ?? 0) === 1 ? 'task' : 'tasks'}; ${skipped.length === 1 ? 'it shows' : 'they show'} as Not rehearsed.`,
        );
    }
    if (end.kind === 'ended') return;
    if (rt.contextPct > contextLimit) {
      // The next turn starts a fresh session from the digest; nothing the builder said is lost.
      await closeLive(rt, 'continued');
      state.write((ctx) => {
        patchShape(ctx, shapeId, { sdkSessionId: null });
      });
      rt.contextPct = 0;
      notice(shapeId, 'Continued in a fresh session; nothing is lost');
      return;
    }
    armIdle(rt);
  };

  const pump = (shapeId: ShapeId, rt: Runtime): void => {
    if (rt.pump !== null) return;
    // With nothing to run the body below finishes synchronously, and its `finally` would clear
    // rt.pump before the assignment stores a settled promise there for good: settled() would spin.
    const progress = { done: false };
    let run: Promise<void> | null = null;
    run = (async () => {
      try {
        while (rt.queue.length > 0 && !rt.held) {
          const turn = rt.queue.shift();
          if (turn === undefined) break;
          rt.current = turn;
          announce(shapeId);
          try {
            await runTurn(shapeId, rt, turn);
          } catch (error) {
            log.error({ err: error, shapeId }, 'a shape turn failed');
            notice(shapeId, "Claude's turn failed; send the message again.");
          } finally {
            rt.current = null;
            announce(shapeId);
          }
        }
      } finally {
        progress.done = true;
        if (rt.pump === run) rt.pump = null;
      }
    })();
    if (!progress.done) rt.pump = run;
  };

  const interrupt = async (rt: Runtime): Promise<void> => {
    rt.interrupted = true;
    await rt.live?.handle.interrupt();
  };

  const settled = async (shapeId: ShapeId): Promise<void> => {
    const rt = runtimeOf(shapeId);
    while (rt.pump !== null) await rt.pump;
  };

  return {
    create: (projectId, input) => state.write((ctx) => insertShape(ctx, projectId, input)),

    startFromTerminal(input) {
      const made: { id: ShapeId | null } = { id: null };
      try {
        return state.write((ctx) => {
          const shape = insertShape(ctx, input.projectId, {
            title: input.title,
            origin: ShapeOrigin.ClaudeCode,
          });
          made.id = shape.id;
          insertShapeMessage(ctx, shape.id, {
            author: ShapeMessageAuthor.Note,
            kind: ShapeMessageKind.Notice,
            body: 'From a Claude Code session',
          });
          insertShapeMessage(ctx, shape.id, {
            author: ShapeMessageAuthor.Builder,
            kind: ShapeMessageKind.Text,
            body: input.summary,
          });
          for (const file of input.files) {
            const bytes = new TextEncoder().encode(file.content);
            const checked = checkDroppedFile({
              name: file.name,
              mediaType: '',
              bytes,
              held: countShapeFiles(ctx.tx, shape.id),
            });
            insertShapeFile(ctx, {
              shapeId: shape.id,
              name: checked.name,
              mediaType: checked.mediaType,
              size: bytes.length,
              storedPath: storeFile(deps.filesDir, shape.id, checked.name, bytes),
            });
          }
          return shape;
        });
      } catch (error) {
        // The write rolled back; the files it had copied are not part of any conversation.
        if (made.id !== null)
          rmSync(join(deps.filesDir, made.id), { recursive: true, force: true });
        throw error;
      }
    },

    addFile(shapeId, file) {
      getShape(state.db, shapeId);
      const checked = checkDroppedFile({
        ...file,
        held: countShapeFiles(state.db, shapeId),
      });
      const storedPath = storeFile(deps.filesDir, shapeId, checked.name, file.bytes);
      try {
        const row = state.write((ctx) =>
          insertShapeFile(ctx, {
            shapeId,
            name: checked.name,
            mediaType: checked.mediaType,
            size: file.bytes.length,
            storedPath,
          }),
        );
        return fileDtoOf(row);
      } catch (error) {
        rmSync(storedPath, { force: true });
        throw error;
      }
    },

    editProposal(shapeId, id, fields) {
      builderAction(shapeId, id, (ctx, label) => {
        editRow(ctx, id, fields);
        // An edit to a task answers the questions the rehearsal asked of it (§7).
        for (const taskKey of editedTaskKeys(getShapeProposal(ctx.tx, id), fields))
          settleOpenQuestionsOfTask(ctx, shapeId, taskKey, 'answered by your edit');
        return editNote(label, fields);
      });
    },

    unpinProposal(shapeId, id, field) {
      builderAction(shapeId, id, (ctx, label) => {
        unpinRow(ctx, id, field);
        return unpinNote(label, field);
      });
    },

    restoreProposal(shapeId, id) {
      builderAction(shapeId, id, (ctx, label) => {
        restoreRow(ctx, id);
        return restoreNote(label);
      });
    },

    dropProposal(shapeId, id) {
      builderAction(shapeId, id, (ctx, label) => {
        if (getShapeProposal(ctx.tx, id).state === ShapeProposalState.Rejected) return null;
        dropRow(ctx, id);
        return dropNote(label);
      });
    },

    send(shapeId, text) {
      const rt = runtimeOf(shapeId);
      const message = say(shapeId, ShapeMessageAuthor.Builder, ShapeMessageKind.Text, text);
      const title = titleFrom(text);
      if (title !== '' && getShape(state.db, shapeId).title === DEFAULT_SHAPE_TITLE)
        state.write((ctx) => {
          patchShape(ctx, shapeId, { title });
        });
      rt.queue.push({
        kind: 'message',
        prompt: `[m:${message.id}] ${text}`,
        messageId: message.id,
      });
      pump(shapeId, rt);
      // Shadow only: nothing waits on it, and it never throws.
      void deps.jev?.heard(shapeId, message.id);
      return message;
    },

    propose(shapeId) {
      const rt = runtimeOf(shapeId);
      if (rt.current?.kind === 'propose' || rt.queue.some((t) => t.kind === 'propose'))
        return { status: 'ignored' };
      const { note, instruction } = proposeNote(getShape(state.db, shapeId).round > 0);
      // The press unlocks propose_plan for good and is a row in the transcript, in one write.
      const message = state.write((ctx) => {
        patchShape(ctx, shapeId, { proposeUnlocked: true });
        return insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Note,
          kind: ShapeMessageKind.Propose,
          body: note,
        });
      });
      rt.queue.push({
        kind: 'propose',
        prompt: `[m:${message.id}] ${instruction}`,
        messageId: message.id,
      });
      pump(shapeId, rt);
      return { status: 'started' };
    },

    rehearse(shapeId, proposalIds) {
      const rt = runtimeOf(shapeId);
      const tasks = unrehearsedTasks(state.db, shapeId, proposalIds);
      if (tasks.length === 0) return { status: 'nothing', tasks: 0 };
      if (rt.current?.kind === 'rehearse' || rt.queue.some((t) => t.kind === 'rehearse'))
        return { status: 'running', tasks: tasks.length };
      const { note, instruction } = rehearseNote(tasks);
      // The note is a row in the transcript, and the turn lists each task at the hash it was read at.
      const message = say(shapeId, ShapeMessageAuthor.Note, ShapeMessageKind.Rehearse, note);
      rt.queue.push({
        kind: 'rehearse',
        prompt: `[m:${message.id}] ${instruction}`,
        messageId: message.id,
        rehearsing: tasks.map((t) => ({ taskKey: t.taskKey, hash: t.hash })),
      });
      pump(shapeId, rt);
      return { status: 'started', tasks: tasks.length };
    },

    resume(shapeId, event) {
      getShape(state.db, shapeId);
      const message = say(shapeId, ShapeMessageAuthor.Note, ShapeMessageKind.Event, event);
      // The session sees what Convert made as it stands now, read-only, ahead of its next turn; a
      // fresh session gets the same lines in its digest.
      const lines = convertedStateLines(state.db, shapeId);
      runtimeOf(shapeId).notes.push(
        [
          `[m:${message.id}] ${event}`,
          ...(lines.length === 0
            ? []
            : [
                'Converted so far, read-only (propose a change or removal only for a task marked "not started"):',
                ...lines,
              ]),
        ].join('\n'),
      );
      return message;
    },

    oneWayPaths: oneWayPathsOf,

    setOneWayPaths(projectId, paths) {
      state.write((ctx) => {
        getProject(ctx.tx, projectId);
        setOneWayPathsRow(ctx, projectId, paths);
      });
      return oneWayPathsOf(projectId);
    },

    dismissFinding(shapeId, findingId, how) {
      const note = state.write((ctx) => {
        const finding = getShapeFinding(ctx.tx, findingId);
        dismissRow(ctx, shapeId, findingId, how ?? 'dismissed by you');
        const body = `The builder dismissed the ${finding.reviewer} ${finding.kind === 'question' ? 'question' : 'finding'} on ${finding.taskKey ?? finding.effortKey}: ${finding.text}`;
        insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Note,
          kind: ShapeMessageKind.Edit,
          body,
        });
        return body;
      });
      runtimeOf(shapeId).notes.push(note);
    },

    view(shapeId) {
      const rt = runtimes.get(shapeId);
      const queue = rt?.queue ?? [];
      return buildShapeView(
        state.db,
        shapeId,
        {
          running: rt !== undefined && rt.current !== null,
          queued: queue.length,
          proposing: rt?.current?.kind === 'propose' || queue.some((t) => t.kind === 'propose'),
          rehearsing: rt?.current?.kind === 'rehearse' || queue.some((t) => t.kind === 'rehearse'),
        },
        worldOfShape(shapeId),
        clock.now(),
      );
    },

    list: (projectId) =>
      listShapes(state.db, projectId).sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
      ),

    removeDraftGoal(goalId) {
      state.write((ctx) => {
        const link = findShapeLinkOfGoal(ctx.tx, goalId);
        if (link === undefined)
          throw new InvalidError(`${goalId} is not a goal a conversation made`);
        removeDraftGoalOf(ctx, link.shapeId, goalId);
      });
    },

    withdrawDecision(shapeId, decisionId, reason) {
      state.write((ctx) => {
        withdrawConvertedDecision(ctx, shapeId, decisionId, reason);
        ctx.emit({
          type: EventType.ShapeChanged,
          entityType: 'shape',
          entityId: shapeId,
          data: { projectId: getShape(ctx.tx, shapeId).projectId },
        });
      });
    },

    async stop(shapeId) {
      const rt = runtimeOf(shapeId);
      if (rt.current !== null) await interrupt(rt);
    },

    async convert(shapeId, proposalIds, options) {
      const rt = runtimeOf(shapeId);
      if (options?.interrupt === true) {
        // Convert Anyway stops the rehearsal (spec §7), queued as well as running: one left in the
        // queue would read proposals that are no longer pending once the hold is released.
        for (let i = rt.queue.length - 1; i >= 0; i -= 1)
          if (rt.queue[i]?.kind === 'rehearse') rt.queue.splice(i, 1);
      }
      if (rt.current !== null) {
        if (options?.interrupt !== true)
          throw new ConflictError('Claude is still answering; Stop or wait');
        rt.held = true;
        await interrupt(rt);
        while (rt.pump !== null) await rt.pump;
      }
      rt.held = true;
      try {
        return state.write((ctx) => {
          const outcome = convertProposals(ctx, shapeId, proposalIds);
          if (outcome.ok && outcome.createdNow > 0)
            insertShapeMessage(ctx, shapeId, {
              author: ShapeMessageAuthor.Note,
              kind: ShapeMessageKind.Event,
              body: `Converted ${String(outcome.createdNow)} ${outcome.createdNow === 1 ? 'proposal' : 'proposals'}`,
            });
          return outcome;
        });
      } finally {
        rt.held = false;
        pump(shapeId, rt);
      }
    },

    toolsFor,
    settled,

    async close() {
      for (const rt of runtimes.values()) {
        rt.idle?.cancel();
        rt.idle = null;
        rt.queue.length = 0;
        await closeLive(rt, 'stopped');
      }
    },
  };
}
