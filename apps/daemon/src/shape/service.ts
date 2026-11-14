import { readFileSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  DeniedBy,
  TrustSurface,
  ConflictError,
  EventType,
  InvalidError,
  ModelMarkBasis,
  NotFoundError,
  providerOf,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeOrigin,
  ShapeProposalState,
  type AccountId,
  shapeFileKind,
  SessionMode,
  type AccountKind,
  type DecisionId,
  type PrincipleId,
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
  type ShapeModelsDto,
  type ShapeViewDto,
  type SessionId,
  type StartShapeInput,
  type AgentAccountKind,
} from '@10db/contracts';
import { buildTrustPolicy, projectLiveSystems } from '../trust';
import { trustSwitchesFor, warnInvalidTrust } from '../permissions';
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
  clearWordingMark,
  markSessionStarted,
  markShapeFilesInline,
  markShapeFilesTold,
  markShapeFilesUnreadableTold,
  markShapeLinksSizeTold,
  patchShape,
  setOneWayPaths as setOneWayPathsRow,
  settleOpenQuestionsOfTask,
  updateSessionUsage,
  type ShapeFileRow,
  type WriteContext,
} from '@10db/db';
import { markModelUnusable } from '../catalogue';
import type { Clock, Timer } from '../clock';
import type { AccountExpectation } from '../environment';
import type { StateStore } from '../events';
import { principlesBrief } from '../knowledge';
import { expandHome, type LaneSandboxSpec, type SessionSetup } from '../sandbox';
import { stringField } from '../guard';
import type { WaitObserver } from '../inbox';
import type { Logger } from '../log';
import { mintSessionToken, type ShapeToolsFor } from '../mcp';
import { streamEventLogFields } from '../sessions';
import type {
  AgentAdapter,
  ExploreSessionSpec,
  SessionEvent,
  SessionHandle,
  SessionMcpServer,
  ShapeImage,
  ShapeVerdict,
  ToolDecision,
  ToolRequest,
  TurnResult,
} from '../sessions';
import {
  effectiveOneWayPaths,
  gitTrackedFiles,
  oneWayNamesOf,
  type TrackedFiles,
} from './ceremony';
import { commandLine, judgeShapeCall, researchLine, type ShapeAccess } from './confinement';
import { convertProposals, type ConvertOutcome, type JoiningProblem } from './convert';
import {
  isFileUnchanged,
  isTextOnly,
  measuredMediaBytes,
  noticeName,
  pagesCharged,
  readAllowance,
  readBytesSpent,
  readCharge,
  readPictureCap,
  readCeiling,
  readCountedLine,
  readMeasuredLine,
  eachFitsAlone,
  carriedNotice,
  readRefusal,
  refusedImageNotice,
  unmeasuredRead,
  unreadableImages,
  unreadableImagesNotice,
} from './read-budget';
import { buildDigest } from './digest';
import {
  asImage,
  checkDroppedFile,
  inlineImageIds,
  pathReasonText,
  pathImageReasons,
  shapeFilesDir,
  storeFile,
} from './dropped-files';
import { dropNote, editNote, restoreNote, rowLabel, unpinNote } from './edit-notes';
import {
  proposeNote,
  rehearseNote,
  SHAPE_ALLOWED_TOOLS,
  shapeSystemPrompt,
  shapeToolset,
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
import {
  FRESH_START_LINE,
  STRICTEST_LIMITS,
  carriedTooMuch,
  inlineBytesSpent,
  inlinePictureBytes,
  pictureLimitsFor,
  type PictureLimits,
  type ScreenService,
} from '../screens';
import type { Hold } from '../verify';
import { createShapeToolHandlers } from './tools';
import { removeDraftGoalOf, withdrawConvertedDecision, withdrawConvertedPrinciple } from './undo';
import { convertedStateNote } from './converted-state';
import { untoldMissized, type UntoldMissized } from './sizing';
import { buildShapeView, fileDtoOf, type ViewWorld } from './view';

// Shape spec §5.1, §5.3, §6, §11. Runs each conversation's session: one turn at a time, a queue, the
// Propose and Convert guards, the move to a fresh session when the context fills, and the idle close.

/** What a conversation's session launches with: the project's checkout and the `plan` role's model. */
export interface ShapeLaunch {
  readonly cwd: string;
  readonly model: string;
  /** The model's own ID, which the account's list is keyed by; `model` is what the account launches it with. */
  readonly modelId: string;
  readonly effort: Effort;
  readonly env: Readonly<Record<string, string>>;
  readonly account: AccountExpectation;
  /** Where the session may read; the service adds the conversation's own files directory. */
  readonly access: Omit<ShapeAccess, 'filesDir'>;
  /** The Agent tool aliases the account takes, which the prompt names and the hook allows; none runs agents on the session's model. */
  readonly agentModels: readonly string[];
}

/** What a session's commands and project tools are prepared from: the conversation and who asks. */
export interface ShapePrepareInput {
  readonly projectId: ProjectId;
  readonly shapeId: ShapeId;
  readonly sessionId: SessionId;
  /** The kind of the account the session runs on, which names where its login is kept. */
  readonly accountKind: AgentAccountKind;
  /** The session's launch env, which the sandbox and the project's servers are built from. */
  readonly env: Readonly<Record<string, string>>;
  readonly resumeProviderSessionId: string | null;
  /** Aborts when the session ends: a card it still waits on is withdrawn. */
  readonly signal: AbortSignal;
  /** Told when a call waits on the builder's card. */
  readonly observer: WaitObserver;
}

/** A session's read-only sandbox, the project's approved MCP servers and its permission broker. */
export interface ShapePrepared {
  /** Null when the sandbox could not be built: the session then runs no command and has no project server. */
  readonly sandbox: LaneSandboxSpec | null;
  /** How the PreToolUse hook judges the session's commands; present with the sandbox. */
  readonly commands?: NonNullable<ShapeAccess['commands']>;
  readonly projectMcpServers: Readonly<Record<string, SessionMcpServer>>;
  /** A line for the prompt naming what was left out (servers, the sandbox) and why, or null. */
  readonly note: string | null;
  /** When the first AWS credentials a server was given expire (ISO), or null: the session moves on before. */
  readonly credentialsExpireAt: string | null;
  /** The project's and the builder's instructions, read when the session was prepared; null when none. */
  readonly instructions: string | null;
  /** What the sandbox kept of the session's setup (Settings › Trust); empty with no sandbox. */
  readonly setup: SessionSetup;
  /** The lanes' permission broker, for this conversation. */
  canUseTool(req: ToolRequest): Promise<ToolDecision>;
  /** Watches what runs under the session's Claude Code process, so its commands end with it. */
  trackProcesses(pid: number): void;
  /** Stops what the session's commands left running, then removes the sandbox; once the session has ended. */
  release(): Promise<void>;
}

export interface ShapeServiceDeps {
  readonly state: StateStore;
  readonly adapter: AgentAdapter;
  readonly clock: Clock;
  readonly log: Logger;
  readonly mcp: { readonly url: string; readonly toolTimeoutMs: number };
  /**
   * Resolves a project's launch, on `model` (an ID the account lists) or, with null, on the `plan`
   * role's, at the conversation's own `effort` or, with null, the role's; throws when its account can't
   * start a session.
   */
  launch(projectId: ProjectId, model: string | null, effort: Effort | null): ShapeLaunch;
  /**
   * Why a project's account can't run a conversation, or null. Reads the project and its account row
   * only, so asking costs no Keychain read.
   */
  brainstormRefusal(projectId: ProjectId): string | null;
  /** The models a conversation of the project may run on (§5.1); none offered without it. */
  readonly models?: (projectId: ProjectId) => ShapeModelsDto;
  /**
   * Prepares a session's commands and project tools (§5.2). Absent (a daemon with no sandbox, tests),
   * the session runs no command and has 10db's tools only.
   */
  readonly prepare?: (input: ShapePrepareInput) => Promise<ShapePrepared>;
  /** Where each conversation's dropped files are kept: `<filesDir>/<shape>/files/`. */
  readonly filesDir: string;
  /** The starter's read of a pending join, which Convert refuses a change of areas over. */
  readonly joiningProblem: JoiningProblem;
  /** How long a session idles before its process closes; 10 minutes. */
  readonly idleMs?: number;
  /** The share of the context window past which a conversation moves to a fresh session; 70. */
  readonly contextLimitPct?: number;
  /** Jev's shadow decisions, told of each builder message (§9); it asks only for a project that opted in. */
  readonly jev?: ShapeJev;
  /** The files git tracks in a checkout, for the ceremony rule's one-way paths (§7); `git ls-files` by default. */
  readonly trackedFiles?: TrackedFiles;
  /** Draws the app's screens for `see_screen` (§5.5); the tool is not offered to a session without it. */
  readonly screens?: Pick<ScreenService, 'see'>;
  /**
   * The picture limits of an account kind (§5.4); `pictureLimitsFor` by default. A test gives smaller round
   * figures to exercise the budget without dropping tens of megabytes.
   */
  readonly limitsFor?: (kind: AccountKind) => PictureLimits;
  /**
   * Holds new turns back, as a waiting update's drain does: while it holds, a queued turn waits
   * before it starts a session or sends to one. A turn already running finishes. A turn that waits
   * has begun nothing, so the install need not wait for it: it waits in `untilClear`, which the
   * drain counts as parked, and the mid-session count takes the parked ones off
   * `turnsInProgress`, which still counts the conversation. If the quit comes first, `close` tells
   * the builder the turn never ran.
   */
  readonly hold?: Hold;
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
  /**
   * Runs the conversation on `model` from its next turn, or on the `plan` role's with null (§5.1), at `effort`
   * or, with null, the model's own default.
   * Throws InvalidError for a model the account doesn't offer and ConflictError while a turn runs or
   * waits; an idle session closes, and the next turn resumes it on the new model.
   */
  chooseModel(shapeId: ShapeId, model: string | null, effort?: Effort | null): ShapeDto;
  /** Everything the screen renders for the conversation, with where its session is. */
  view(shapeId: ShapeId): ShapeViewDto;
  /** The project's conversations, the one touched last first. */
  list(projectId: ProjectId): ShapeDto[];
  /**
   * Remove Draft Goal (spec §11), found through the conversation that made the goal. Throws
   * InvalidError for a goal no conversation made and ConflictError once a task has started.
   */
  removeDraftGoal(goalId: GoalId): void;
  /** Withdraw Decision: a decision the conversation wrote, with the builder's reason. */
  withdrawDecision(shapeId: ShapeId, decisionId: DecisionId, reason: string): void;
  /**
   * Withdraw Principle: a principle the conversation wrote, with the builder's reason; the same
   * withdrawal the knowledge routes make. Throws ConflictError once a later principle replaced it.
   */
  withdrawPrinciple(shapeId: ShapeId, principleId: PrincipleId, reason: string): void;
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
  /**
   * How many conversations have a turn running or queued: Claude is answering the builder, and a
   * quit now would cut the answer off. A conversation counts once, however many turns it has queued.
   */
  turnsInProgress(): number;
  /**
   * The conversations whose turn has begun, by name: those `turnsInProgress` counts minus the ones
   * a drain or the install holds back before they started anything. An update waits for exactly
   * these, so it can say which conversation keeps it waiting.
   */
  runningTurns(): { id: ShapeId; title: string }[];
  /** Stops every session, and tells each conversation which queued turns will not run. */
  close(): Promise<void>;
}

/** A conversation's name until its first message gives it one. */
export const DEFAULT_SHAPE_TITLE = 'New conversation';

/** The service closed while a session was being prepared for a turn, so the turn never ran. */
class ShapeClosedError extends Error {
  override readonly name = 'ShapeClosedError';
  constructor() {
    super('10db closed before the session started');
  }
}

/** The builder pressed Stop while a session was being prepared for a turn. */
class ShapeStoppedError extends Error {
  override readonly name = 'ShapeStoppedError';
  constructor() {
    super('The turn was stopped before its session started');
  }
}

/** How long before its AWS credentials expire a session gives way to a fresh one, which gets new ones. */
const CREDENTIALS_MARGIN_MS = 5 * 60_000;

/** What a session with nothing prepared answers a call it would have asked about: it has no broker. */
const NOTHING_TO_ASK =
  'This planning session has no sandbox, so it runs no command and asks for nothing.';
const TITLE_MAX = 60;
/** What the builder reads when a Propose turn's accepted plan has nothing in it. */
const EMPTY_PLAN_NOTICE =
  'The plan came back empty: nothing has been decided yet. Say what you want built, or answer Claude’s questions, then press Propose Again.';

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
  /** What the builder is told if 10db quits first: the queue is in memory and ends with the daemon. */
  readonly neverRan: string;
}

/** What goes ahead of a turn's message: the builder's edits since the last turn and the files dropped. */
interface Intake {
  readonly notes: readonly string[];
  readonly files: readonly ShapeFileRow[];
  /** Finished tasks outside their size that Claude has not heard about. */
  readonly missized: UntoldMissized;
  /** What Convert made as it stands now, null when nothing was converted. */
  readonly converted: string | null;
}

/**
 * What the pictures of a turn are held to: the limits of the account the session runs on, and the inline image
 * bytes the conversation's earlier turns spent, which a resumed session resends.
 */
interface Budget {
  readonly limits: PictureLimits;
  readonly spent: number;
}

/** The image blocks a turn carries, and the files they came from. */
/** The images a Read would refuse, and whether Reading any one of them first would be let in. */
interface Unreadable {
  readonly files: readonly ShapeFileRow[];
  readonly readFirst: boolean;
  /** The names of images the conversation's total left out of the message, which went to Claude as a path. */
  readonly leftOut: readonly string[];
  /** The limits the notices state. */
  readonly limits: PictureLimits;
}

interface SentImages {
  readonly images: ShapeImage[];
  readonly ids: ShapeFileRow['id'][];
}

type TurnEnd =
  | { readonly kind: 'complete'; readonly result: TurnResult | undefined }
  | { readonly kind: 'ended' };

interface Live {
  readonly handle: SessionHandle;
  readonly sessionId: SessionId;
  /**
   * Ends what the session was prepared with: its cards are withdrawn, what its commands left running is
   * stopped and its sandbox removed. Runs once, however often it is called.
   */
  release(): Promise<void>;
  /** Watches what runs under its Claude Code process, whose pid its start reports. */
  track(pid: number): void;
  /** When the AWS credentials its servers were given expire (ISO), or null. */
  readonly expiresAt: string | null;
  /** The picture limits of the account this session runs on, which it keeps even if the project's changes. */
  readonly limits: PictureLimits;
  /** The account and the model (by its own ID, not the one the account launches it with) it runs on, for a refusal to mark. */
  readonly account: AccountId;
  readonly model: string;
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
  /** Set while the next turn waits for the hold (a drain) to clear: nothing of it has started. */
  parked: boolean;
  pump: Promise<void> | null;
  idle: Timer | null;
  contextPct: number;
  /** Whether the turn running now has had an accepted propose_plan call, and how many were refused. */
  proposed: boolean;
  /** Whether the last accepted propose_plan call of the turn left the plan empty: no pending or converted row. */
  emptyPlan: boolean;
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
  /** Set by `close`: a turn queued after it is reported as never run, not started. */
  let closed = false;
  /** `closed` read afresh, for after an await, where the compiler would still take it as false. */
  const isClosed = (): boolean => closed;

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
        parked: false,
        pump: null,
        idle: null,
        contextPct: 0,
        proposed: false,
        emptyPlan: false,
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
      ...(deps.models === undefined ? {} : { models: deps.models(projectId) }),
    };
  };
  const worldOfShape = (shapeId: ShapeId): ViewWorld =>
    worldOf(getShape(state.db, shapeId).projectId);

  const limitsFor = deps.limitsFor ?? pictureLimitsFor;
  /**
   * The picture limits a conversation's next session would run under: those of the account the project's launch
   * names now. A launch that can't be resolved (its account can't start a session) is held to the strictest,
   * since the start that follows fails with the reason anyway.
   */
  const launchLimits = (shapeId: ShapeId): PictureLimits => {
    try {
      const shape = getShape(state.db, shapeId);
      return limitsFor(deps.launch(shape.projectId, shape.model, shape.effort).account.kind);
    } catch {
      return STRICTEST_LIMITS;
    }
  };
  /**
   * Refuses a request for a project whose account can't run a conversation, so the builder is told when
   * they ask instead of by a notice in a transcript that never reached Claude. Any other reason a launch
   * can't be resolved is left to the start that follows.
   */
  const refuseChatGptAccount = (projectId: ProjectId): void => {
    const why = deps.brainstormRefusal(projectId);
    if (why !== null) throw new InvalidError(why);
  };
  /** The limits a conversation's pictures are held to: its live session's, or the next one's. */
  const limitsOf = (shapeId: ShapeId, rt: Runtime): PictureLimits =>
    rt.live?.limits ?? launchLimits(shapeId);

  const { screens } = deps;
  const toolsFor: ShapeToolsFor = ({ shapeId }) =>
    createShapeToolHandlers(
      {
        state,
        // A screen is held to the limits of the account the session that asked for it runs on.
        ...(screens === undefined
          ? {}
          : {
              screens: {
                see: (id, input) => screens.see(id, input, limitsOf(id, runtimeOf(id))),
              },
            }),
        world: worldOfShape,
        onProposal: (id, accepted, empty = false) => {
          const rt = runtimeOf(id);
          if (accepted) {
            rt.proposed = true;
            rt.emptyPlan = empty;
          } else rt.refused += 1;
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
        // What its commands start is watched from its own process, and stopped when it ends.
        if (event.pid !== null) live.track(event.pid);
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
          // The model ran a turn: a mark from an error's wording alone on it was wrong.
          if ((event.result ?? 'success') === 'success')
            clearWordingMark(ctx, live.account, live.model);
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
        // What it was prepared with goes once its events end (consume), which closing waits for.
        state.write((ctx) => {
          endSession(ctx, live.sessionId, live.endReason ?? event.reason);
        });
        if (running) rt.live = null;
        if (event.reason === 'model_refused')
          markModelUnusable(
            { state, clock },
            live.account,
            live.model,
            event.refusalBasis ?? ModelMarkBasis.Error,
          );
        if (live.endReason === null && event.reason !== 'completed' && event.reason !== 'stopped')
          notice(shapeId, event.message ?? `Claude's session ended (${event.reason}).`);
        if (running) rt.waiting?.({ kind: 'ended' });
        break;
      case 'text_delta':
      case 'reasoning_delta':
      case 'message':
      case 'tool_call':
      case 'commands':
      case 'plan_update':
        log.debug({ shapeId, ...streamEventLogFields(event) }, 'session stream event');
        break;
      // Plan runs in default mode, so auto mode never denies one of its calls (`judge_denied`).
      case 'activity':
      case 'compacted':
      case 'background_tasks':
      case 'consumed':
      case 'judge_denied':
        break;
    }
  };

  const consume = async (shapeId: ShapeId, rt: Runtime, live: Live): Promise<void> => {
    try {
      for await (const event of live.handle.events) onEvent(shapeId, rt, live, event);
    } catch (error) {
      log.error({ err: error, shapeId }, 'shape session events failed');
    } finally {
      // Its sandbox's sealed files can hold AWS credentials: closing (and the daemon's stop) waits for them to go.
      await live.release();
    }
  };

  // --- Starting a session -----------------------------------------------------------------------

  /** The lines that tell Claude what changed since it last heard: edits, mis-sized tasks, files. */
  const intakeText = (
    intake: Intake,
    budget: Budget,
    shown: readonly ShapeFileRow[] = intake.files,
    sizes: readonly string[] = intake.missized.lines,
    converted: string | null = intake.converted,
  ): string => {
    // An image not sent as a block is named as a path, with the reason and the way to read it.
    const byPath = pathImageReasons(shown, intake.files, budget.spent, budget.limits);
    return [
      ...intake.notes.map((note) => `[note] ${note}`),
      ...(converted === null ? [] : [`[note] ${converted}`]),
      ...(sizes.length === 0 ? [] : [`[note] ${sizes.join('\n')}`]),
      ...shown.map((file) => {
        const reason = byPath.get(file.id);
        return `[file] ${file.storedPath} (${file.name})${reason === undefined ? '' : ` — ${pathReasonText(reason, budget.limits)}; Read it`}`;
      }),
    ].join('\n');
  };

  /**
   * Tells the builder which images this turn points Claude at as a path that a Read would refuse, because the
   * pictures the session already carries leave no room in the pool (§5.4). `shown` are the files the message
   * names, `intake.files` the ones it sends, and a `fresh` session carries no earlier picture or Read.
   * Returns the images that would be refused, read from the state before the turn is marked told; the turn
   * says so through `warnUnreadable` once it has reached Claude, so a turn that fails leaves its retry to say it.
   */
  const unreadableOf = (
    shapeId: ShapeId,
    intake: Intake,
    limits: PictureLimits,
    spent: number,
    shown: readonly ShapeFileRow[],
    sentInline: ReadonlySet<ShapeFileRow['id']>,
    fresh: boolean,
  ): Unreadable => {
    const byPath = pathImageReasons(shown, intake.files, fresh ? 0 : spent, limits);
    // The builder is told which images the conversation's total left out, since Claude is told only a path.
    const leftOut = shown
      .filter((file) => byPath.get(file.id) === 'conversation-full')
      .map(noticeName);
    const paths = shown.filter((file) => byPath.has(file.id));
    if (paths.length === 0) return { files: [], readFirst: false, leftOut, limits };
    const inline =
      (fresh ? 0 : inlinePictureBytes(state, deps.filesDir, shapeId, limits)) +
      intake.files.reduce((sum, file) => sum + (sentInline.has(file.id) ? file.size : 0), 0);
    const messages = fresh ? [] : listShapeMessages(state.db, shapeId);
    const room = readCeiling(inline, limits) - readBytesSpent(messages);
    const cap = readPictureCap(messages);
    const files = unreadableImages(paths, room, cap);
    // Reading one first only helps when the room left takes any one of them.
    return { files, readFirst: eachFitsAlone(files, room, cap), leftOut, limits };
  };

  /** Writes the notices for the images `unreadableOf` found, if any. */
  const warnUnreadable = (shapeId: ShapeId, unreadable: Unreadable): void => {
    if (unreadable.leftOut.length > 0)
      notice(
        shapeId,
        `Left out of this message to keep the conversation within ${unreadable.limits.limitText}: ` +
          `${unreadable.leftOut.join(', ')}. Claude has ${unreadable.leftOut.length === 1 ? 'its path' : 'their paths'} and can Read ${unreadable.leftOut.length === 1 ? 'it' : 'them'}.`,
      );
    if (unreadable.files.length > 0)
      noticeUnreadable(
        shapeId,
        unreadable.files,
        unreadableImagesNotice(
          unreadable.files.map(noticeName),
          unreadable.readFirst,
          unreadable.limits,
        ),
      );
  };

  /** Sends a notice that names these images, and marks each so a refused Read doesn't name it again. */
  const noticeUnreadable = (
    shapeId: ShapeId,
    files: readonly ShapeFileRow[],
    body: string,
  ): void => {
    state.write((ctx) => {
      insertShapeMessage(ctx, shapeId, {
        author: ShapeMessageAuthor.Note,
        kind: ShapeMessageKind.Notice,
        body,
      });
      markShapeFilesUnreadableTold(
        ctx,
        files.map((f) => f.id),
      );
    });
  };

  /**
   * Tells the builder a Read of one of the conversation's dropped images was refused, unless an earlier notice
   * already named that image (§5.4). `warnUnreadable` only predicts, so this covers what it can't: images of
   * earlier turns no Read had made room for, room spent after the send, and Reads out of the assumed order.
   */
  const noticeRefusedImage = (
    shapeId: ShapeId,
    readPath: string,
    access: Pick<ShapeAccess, 'checkout' | 'home'>,
    limits: PictureLimits,
  ): void => {
    const target = resolvePath(access.checkout, expandHome(readPath, access.home));
    const file = listShapeFiles(state.db, shapeId).find(
      (f) => resolvePath(f.storedPath) === target,
    );
    if (file?.unreadableToldAt === null)
      noticeUnreadable(shapeId, [file], refusedImageNotice(noticeName(file), limits));
  };

  /** The dropped images among the files that fit in a message, read from where the daemon keeps them. */
  const imagesOf = (files: readonly ShapeFileRow[], budget: Budget): SentImages => {
    const inline = inlineImageIds(files, budget.spent, budget.limits);
    const sent: SentImages = { images: [], ids: [] };
    for (const file of files) {
      if (!inline.has(file.id)) continue;
      try {
        const kind = shapeFileKind(file.name);
        const image = kind === null ? null : asImage(kind, readFileSync(file.storedPath));
        if (image === null) continue;
        sent.images.push(image);
        sent.ids.push(file.id);
      } catch (error) {
        log.warn({ err: error, file: file.name }, 'a dropped image could not be read');
      }
    }
    return sent;
  };

  /**
   * Takes what has gathered for the conversation's next turn. Which files Claude has not been told
   * and which mis-sized tasks is read from the database, so what waited through a restart still
   * reaches it.
   */
  const takeIntake = (shapeId: ShapeId, rt: Runtime): Intake => ({
    notes: rt.notes.splice(0),
    files: listUntoldShapeFiles(state.db, shapeId),
    missized: untoldMissized(state.db, shapeId),
    // What Convert made, as it stands as the turn starts. Whatever state the conversation is in: a
    // partial Convert or a re-plan round leaves it Proposed with converted rows.
    converted: convertedStateNote(state.db, shapeId),
  });

  /**
   * Records that the turn just sent carried these files and these mis-sized tasks, and which of the
   * files went as image blocks. A `fresh` session resends no earlier block, so it clears the others.
   */
  const told = (
    shapeId: ShapeId,
    files: readonly ShapeFileRow[],
    missized: UntoldMissized,
    inline: readonly ShapeFileRow['id'][],
    fresh: boolean,
  ): void => {
    state.write((ctx) => {
      markShapeFilesTold(
        ctx,
        files.map((f) => f.id),
      );
      markShapeFilesInline(ctx, shapeId, inline, fresh);
      markShapeLinksSizeTold(ctx, missized.linkIds);
    });
  };

  /** Starts the conversation's session with `prompt` as its first message. */
  const start = async (
    shapeId: ShapeId,
    rt: Runtime,
    turn: Turn,
    intake: Intake,
  ): Promise<void> => {
    const shape = getShape(state.db, shapeId);
    const launch = deps.launch(shape.projectId, shape.model, shape.effort);
    // Only this conversation's files: another conversation's, in the same project or not, stay unread.
    const fileAccess: ShapeAccess = {
      ...launch.access,
      filesDir: shapeFilesDir(deps.filesDir, shapeId),
      // An agent the session launches takes only the aliases its account's Agent tool resolves.
      agentModels: launch.agentModels,
    };
    const limits = limitsFor(launch.account.kind);
    let resumeId = getShapeSdkSessionId(state.db, shapeId);
    // A resumed session resends every earlier picture to the account that resumes it, which is not always the
    // one that began it (a plan falling back to Bedrock): one that would resend more than this account takes
    // is not resumed. It starts from the digest and carries no earlier picture, and the builder is told.
    const tooMuch =
      resumeId === null ? null : carriedTooMuch(state, deps.filesDir, shapeId, limits);
    if (tooMuch !== null) {
      resumeId = null;
      state.write((ctx) => {
        patchShape(ctx, shapeId, { sdkSessionId: null });
      });
      notice(shapeId, carriedNotice(launch.account.label, tooMuch, limits));
    }
    const transcript = listShapeMessages(state.db, shapeId);
    const parts: string[] = [];
    // A session with nothing to resume, a new conversation's or one moved on at 70%, is told the
    // standing rules; a resumed one heard them in its first turn.
    if (resumeId === null) {
      const brief = principlesBrief(state.db, shape.projectId);
      if (brief !== '') parts.push(brief);
    }
    // No session to resume, and Claude has spoken: a session that lost it starts from the digest,
    // which is stored so what it saw is on record.
    const spoken = transcript.some(
      (m) => m.author === ShapeMessageAuthor.Claude && m.kind === ShapeMessageKind.Text,
    );
    const digested = resumeId === null && spoken;
    if (digested) {
      const digest = buildDigest(state.db, shapeId);
      say(shapeId, ShapeMessageAuthor.Note, ShapeMessageKind.Digest, digest);
      parts.push(digest);
    } else if (
      resumeId === null &&
      transcript.some(
        (m) =>
          m.kind === ShapeMessageKind.Screen ||
          (m.kind === ShapeMessageKind.Tool && m.body.startsWith('Read · ')),
      )
    ) {
      // No digest row marks this session's start (Claude never spoke), so the screens and Reads of the
      // lost one, still in the transcript, would be charged to this one. This line marks it instead.
      say(shapeId, ShapeMessageAuthor.Note, ShapeMessageKind.Tool, FRESH_START_LINE);
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
    // A fresh session resends no earlier block, so only a resumed one carries what the conversation spent.
    const budget: Budget = {
      limits,
      spent: resumeId === null ? 0 : inlineBytesSpent(state, deps.filesDir, shapeId, limits),
    };
    // The digest already names every mis-sized task and every converted row.
    const lines = intakeText(
      intake,
      budget,
      files,
      digested ? [] : intake.missized.lines,
      digested ? null : intake.converted,
    );
    if (lines !== '') parts.push(lines);
    parts.push(turn.prompt);
    const prompt = parts.join('\n\n');
    const { images, ids: inlineIds } = imagesOf(intake.files, budget);
    // Worked out now, from the state before this turn is marked told, and said once the session has started.
    const unreadable = unreadableOf(
      shapeId,
      intake,
      limits,
      budget.spent,
      files,
      new Set(inlineIds),
      resumeId === null,
    );
    const { token, hash } = mintSessionToken();
    const row = state.write((ctx) =>
      insertSession(ctx, {
        shapeId,
        provider: providerOf(launch.account.kind),
        model: launch.model,
        effort: launch.effort,
        mode: SessionMode.Managed,
        mcpTokenHash: hash,
      }),
    );
    // Its sandbox, the project's servers and its broker; a card it waits on is withdrawn when it ends.
    const ending = new AbortController();
    let prepared: ShapePrepared | null;
    try {
      prepared =
        deps.prepare === undefined
          ? null
          : await deps.prepare({
              projectId: shape.projectId,
              shapeId,
              sessionId: row.id,
              accountKind: launch.account.kind,
              env: launch.env,
              resumeProviderSessionId: resumeId,
              signal: ending.signal,
              observer: {
                onWaitStart: (item) => {
                  say(
                    shapeId,
                    ShapeMessageAuthor.Claude,
                    ShapeMessageKind.Tool,
                    `${item.title} · waiting for your answer in the Inbox`,
                  );
                },
                onWaitEnd: () => undefined,
              },
            });
    } catch (error) {
      state.write((ctx) => {
        endSession(ctx, row.id, 'start_failed');
      });
      throw error;
    }
    const ready = prepared;
    let released: Promise<void> | null = null;
    const release = (): Promise<void> => {
      released ??= (async () => {
        ending.abort();
        try {
          await ready?.release();
        } catch (error) {
          log.warn({ err: error, shapeId }, 'a shape session’s sandbox could not be removed');
        }
      })();
      return released;
    };
    // The service closed, or the builder pressed Stop, while the session was prepared: neither could
    // reach a session that wasn't live yet, so none starts now.
    if (isClosed() || rt.interrupted) {
      await release();
      state.write((ctx) => {
        endSession(ctx, row.id, 'start_failed');
      });
      throw isClosed() ? new ShapeClosedError() : new ShapeStoppedError();
    }
    const commands = ready?.commands;
    // The setup's folders are read as the sandbox opened them, and a `.env*` inside them stays closed.
    const setup = ready?.setup ?? null;
    const withSetup: ShapeAccess =
      setup === null || setup.reads.length === 0
        ? fileAccess
        : {
            ...fileAccess,
            setupReads: setup.reads,
            secretFiles: [...(fileAccess.secretFiles ?? []), ...setup.secretFiles],
          };
    const access: ShapeAccess = commands === undefined ? withSetup : { ...withSetup, commands };
    const toolset = shapeToolset(commands !== undefined);
    // What was left out (servers, the sandbox), named so the session doesn't hunt for it.
    const skipped = ready?.note ?? null;
    const project = getProject(state.db, shape.projectId);
    // Read as each session starts, as a lane's is: a live system named meanwhile applies from the next one.
    const policy = buildTrustPolicy({
      surface: TrustSurface.Plan,
      projectName: project.name,
      checkout: launch.cwd,
      gateCommand: project.gateCommand,
      liveSystems: projectLiveSystems(state.db, project.id, (stored) => {
        log.warn({ stored }, 'the stored live systems are not a list 10db reads, so it reads none');
      }),
      switches: trustSwitchesFor(state.db, project.id, warnInvalidTrust(log)),
    });
    const spec: ExploreSessionSpec = {
      sessionId: row.id,
      policy,
      profile: {
        kind: 'explore',
        shapeId,
        systemPrompt: shapeSystemPrompt(launch.agentModels),
        tools: [...toolset.tools],
        allowedTools: SHAPE_ALLOWED_TOOLS,
        disallowedTools: [...toolset.disallowedTools],
        agents: toolset.agents,
      },
      cwd: launch.cwd,
      instructions: ready?.instructions ?? null,
      ...(setup === null
        ? {}
        : { setup: { plugins: setup.pluginDirs, skillRoots: setup.skillRoots } }),
      prompt: skipped === null ? prompt : `${skipped}\n\n${prompt}`,
      ...(images.length === 0 ? {} : { images }),
      model: launch.model,
      effort: launch.effort,
      resumeProviderSessionId: resumeId,
      env: launch.env,
      account: launch.account,
      mcp: { url: deps.mcp.url, token, toolTimeoutMs: deps.mcp.toolTimeoutMs },
      sandbox: ready?.sandbox ?? null,
      projectMcpServers: ready?.projectMcpServers ?? {},
      canUseTool: (req) =>
        ready === null
          ? Promise.resolve({ behavior: 'deny', message: NOTHING_TO_ASK, by: DeniedBy.TenDb })
          : ready.canUseTool(req),
      preToolUse: (req) => {
        let verdict: ShapeVerdict = judgeShapeCall(
          {
            toolName: req.toolName,
            toolInput: req.input,
            agentId: req.agentId,
            agentType: req.agentType,
            cwd: req.cwd,
          },
          access,
        );
        // A picture or PDF the session itself Reads is resent with every later request (§5.4); a subagent's
        // reaches the session as text, so only the session's own Reads are counted.
        const readPath =
          verdict.decision === 'allow' && req.toolName === 'Read' && req.agentId === undefined
            ? stringField(req.input, 'file_path')
            : null;
        const messages = readPath === null ? [] : listShapeMessages(state.db, shapeId);
        // Reads in one message all pass here before any result is measured, so a picture is charged a
        // bound on its result: its file's size until a large one is measured, then the largest measured.
        const allowance = readAllowance(messages);
        const charged =
          readPath === null
            ? null
            : readCharge(
                readPath,
                stringField(req.input, 'pages'),
                access,
                allowance,
                readPictureCap(messages),
              );
        if (readPath !== null && charged !== null && charged.bytes > 0) {
          const refusal = readRefusal(
            readPath,
            charged.bytes,
            readBytesSpent(messages),
            // Reads get whatever the inline pictures leave of the pool they share.
            readCeiling(inlinePictureBytes(state, deps.filesDir, shapeId, limits), limits),
            charged.kind,
            allowance,
            limits,
          );
          if (refusal !== null) {
            verdict = { decision: 'deny', reason: refusal };
            if (charged.kind === 'picture') noticeRefusedImage(shapeId, readPath, access, limits);
          } else
            say(
              shapeId,
              ShapeMessageAuthor.Claude,
              ShapeMessageKind.Tool,
              readCountedLine(readPath, charged.bytes, charged.kind),
            );
        }
        if (verdict.decision === 'deny')
          say(
            shapeId,
            ShapeMessageAuthor.Claude,
            ShapeMessageKind.Tool,
            `${req.toolName} · refused · ${verdict.reason}`,
          );
        else {
          // Research (§5.2): the question and every search and fetch shows, so the builder sees
          // what left the machine; so does every command and project tool call, and who made it.
          const line =
            researchLine(req.toolName, req.input) ??
            commandLine(req.toolName, req.input, req.agentType);
          if (line !== null) say(shapeId, ShapeMessageAuthor.Claude, ShapeMessageKind.Tool, line);
        }
        return verdict;
      },
      postToolUse: (req) => {
        // The result of a Read the hook counted: what came back replaces the allowance it was charged.
        if (req.toolName !== 'Read' || req.agentId !== undefined) return;
        const path = stringField(req.input, 'file_path');
        if (path === null) return;
        // A measured 0 can't tell 'the bytes stayed on disk' (a `parts` result, which keeps its allowance)
        // from 'nothing was added' (`file_unchanged`: Claude Code answered that an earlier tool result still
        // stands), so the result's type decides: the second gives its whole charge back, and so does a result
        // that is only text (a Read refused with a reason, such as a long PDF with no `pages`).
        const measured = measuredMediaBytes(req.response);
        const nothingAdded =
          isFileUnchanged(req.response) || (measured === 0 && isTextOnly(req.response));
        if (measured === 0 && !nothingAdded) return;
        // What the hook counted for this Read, from the transcript: the allowance can have grown since,
        // when another Read of the same message was measured first.
        const counted = unmeasuredRead(listShapeMessages(state.db, shapeId), path);
        if (counted === null) return;
        const pages = pagesCharged(stringField(req.input, 'pages'));
        say(
          shapeId,
          ShapeMessageAuthor.Claude,
          ShapeMessageKind.Tool,
          readMeasuredLine(
            path,
            measured,
            counted.counted,
            counted.kind,
            Number.isFinite(pages) ? pages : undefined,
          ),
        );
      },
      toolFailed: (req) => {
        // A failed Read returned nothing, so it gives back what it was counted, which can be a whole file.
        if (req.toolName !== 'Read' || req.agentId !== undefined) return;
        const path = stringField(req.input, 'file_path');
        if (path === null) return;
        const counted = unmeasuredRead(listShapeMessages(state.db, shapeId), path);
        if (counted === null) return;
        say(
          shapeId,
          ShapeMessageAuthor.Claude,
          ShapeMessageKind.Tool,
          readMeasuredLine(path, 0, counted.counted, counted.kind),
        );
      },
    };
    let handle: SessionHandle;
    try {
      handle = adapter.open(spec);
    } catch (error) {
      // The row was written with its token hash before the adapter ran; end it so no live row
      // keeps a token that getLiveSessionByTokenHash would accept.
      state.write((ctx) => {
        endSession(ctx, row.id, 'start_failed');
      });
      await release();
      throw error;
    }
    const live: Live = {
      handle,
      sessionId: row.id,
      release,
      track: (pid) => {
        ready?.trackProcesses(pid);
      },
      expiresAt: ready?.credentialsExpireAt ?? null,
      limits,
      account: launch.account.accountId,
      model: launch.modelId,
      endReason: null,
      done: Promise.resolve(),
    };
    rt.live = live;
    told(shapeId, files, intake.missized, inlineIds, resumeId === null);
    warnUnreadable(shapeId, unreadable);
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
    rt.emptyPlan = false;
    rt.refused = 0;
    rt.interrupted = false;
    // A session whose servers' AWS credentials are about to expire gives way; the next one, resumed,
    // gets fresh ones.
    const expires = rt.live?.expiresAt ?? null;
    if (
      rt.live !== null &&
      expires !== null &&
      clock.now().getTime() >= Date.parse(expires) - CREDENTIALS_MARGIN_MS
    )
      void closeLive(rt, 'credentials expiring');
    // The turn counts as running (rt.current) while the last session finishes closing.
    if (rt.live === null && rt.closing !== null) await rt.closing;
    // close() ran while this turn waited: it emptied the queue before this turn was told, and no
    // session may start now, for close() would not stop it. Notes and files stay unconsumed.
    if (isClosed()) {
      notice(shapeId, turn.neverRan);
      return;
    }
    const ended = new Promise<TurnEnd>((resolve) => {
      rt.waiting = resolve;
    });
    const intake = takeIntake(shapeId, rt);
    try {
      if (rt.live === null) await start(shapeId, rt, turn, intake);
      else {
        // The live session keeps the account it started on, so its limits hold even if the project's changed.
        const { limits } = rt.live;
        const budget: Budget = {
          limits,
          spent: inlineBytesSpent(state, deps.filesDir, shapeId, limits),
        };
        const lines = intakeText(intake, budget);
        const { images, ids } = imagesOf(intake.files, budget);
        const unreadable = unreadableOf(
          shapeId,
          intake,
          limits,
          budget.spent,
          intake.files,
          new Set(ids),
          false,
        );
        rt.live.handle.send(lines === '' ? turn.prompt : `${lines}\n\n${turn.prompt}`, images);
        told(shapeId, intake.files, intake.missized, ids, false);
        warnUnreadable(shapeId, unreadable);
      }
    } catch (error) {
      // The turn never reached Claude, so what was to go ahead of it waits for the next one; its
      // files and mis-sized tasks were never marked told.
      rt.notes.unshift(...intake.notes);
      rt.waiting = null;
      if (error instanceof ShapeClosedError) {
        notice(shapeId, turn.neverRan);
        return;
      }
      // Stopped before it started: the turn ends as a stopped one does.
      if (error instanceof ShapeStoppedError) return;
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
    const emptyIn = (): boolean => rt.emptyPlan;
    const failed = end.kind === 'complete' && end.result === 'error' && !stopped();
    if (failed) notice(shapeId, "Claude's turn failed; send the message again.");
    if (end.kind === 'complete' && !failed && !stopped() && turn.kind === 'propose') {
      if (!proposedIn()) {
        log.info({ shapeId, refusedProposals: rt.refused }, 'a propose turn proposed nothing');
        notice(shapeId, "Claude didn't propose; Propose Again");
      } else if (emptyIn()) {
        log.info({ shapeId }, 'a propose turn ended with an empty plan');
        notice(shapeId, EMPTY_PLAN_NOTICE);
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
          // Closed: the daemon is stopping, and the hold letting go on its way out must not start a
          // session for a message that arrived after `close` emptied the queue.
          if (closed) {
            for (const turn of rt.queue.splice(0)) notice(shapeId, turn.neverRan);
            break;
          }
          // A drain starts nothing new: wait, then look again, as the queue or Convert's hold may
          // have changed meanwhile.
          if (deps.hold?.holding() === true) {
            rt.parked = true;
            // The screen says the turn waits for an update, and takes the line back when it lets go.
            announce(shapeId);
            try {
              await deps.hold.untilClear();
            } finally {
              rt.parked = false;
              // Closed: the store may be shut already, and the screen is gone with the daemon.
              if (!isClosed()) announce(shapeId);
            }
            continue;
          }
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
    create(projectId, input) {
      refuseChatGptAccount(projectId);
      return state.write((ctx) => insertShape(ctx, projectId, input));
    },

    startFromTerminal(input) {
      refuseChatGptAccount(input.projectId);
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
      refuseChatGptAccount(getShape(state.db, shapeId).projectId);
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
        neverRan: `10db quit before Claude read “${title}”, so it went unanswered. Send it again.`,
      });
      pump(shapeId, rt);
      // Shadow only: nothing waits on it, and it never throws.
      void deps.jev?.heard(shapeId, message.id);
      return message;
    },

    propose(shapeId) {
      refuseChatGptAccount(getShape(state.db, shapeId).projectId);
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
        neverRan: '10db quit before Claude could propose. Press Propose again.',
      });
      pump(shapeId, rt);
      return { status: 'started' };
    },

    rehearse(shapeId, proposalIds) {
      refuseChatGptAccount(getShape(state.db, shapeId).projectId);
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
        neverRan: '10db quit before the rehearsal ran. Press Rehearse again.',
      });
      pump(shapeId, rt);
      return { status: 'started', tasks: tasks.length };
    },

    resume(shapeId, event) {
      getShape(state.db, shapeId);
      const message = say(shapeId, ShapeMessageAuthor.Note, ShapeMessageKind.Event, event);
      // Only the event: every turn works out what Convert made as it starts, so a note queued here
      // would go stale before it was sent.
      runtimeOf(shapeId).notes.push(`[m:${message.id}] ${event}`);
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

    chooseModel(shapeId, model, effort = null) {
      const { projectId } = getShape(state.db, shapeId);
      refuseChatGptAccount(projectId);
      const offered = (deps.models?.(projectId).offered ?? []).map((o) => o.model);
      if (model !== null && !offered.includes(model))
        throw new InvalidError(
          `${model} is not a model this project's account offers; choose one of ${offered.join(', ') || 'none'}.`,
        );
      const rt = runtimes.get(shapeId);
      if (rt !== undefined && (rt.current !== null || rt.queue.length > 0))
        throw new ConflictError(
          'The model changes between turns: wait for the turn to end, or stop it, then choose again.',
        );
      const shape = state.write((ctx) => patchShape(ctx, shapeId, { model, effort }));
      // A live session runs on the model it started with; the next turn resumes it on the new one.
      if (rt?.live) void closeLive(rt, 'model changed');
      return shape;
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
          waitingForUpdate: rt?.parked === true && queue.length > 0,
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

    withdrawPrinciple(shapeId, principleId, reason) {
      state.write((ctx) => {
        withdrawConvertedPrinciple(ctx, shapeId, principleId, reason);
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
          const outcome = convertProposals(ctx, shapeId, proposalIds, deps.joiningProblem);
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

    turnsInProgress() {
      let count = 0;
      for (const rt of runtimes.values())
        if (rt.current !== null || rt.queue.length > 0 || rt.parked) count += 1;
      return count;
    },

    runningTurns() {
      const running: { id: ShapeId; title: string }[] = [];
      for (const [shapeId, rt] of runtimes)
        if ((rt.current !== null || rt.queue.length > 0) && !rt.parked)
          running.push({ id: shapeId, title: getShape(state.db, shapeId).title });
      return running;
    },

    async close() {
      closed = true;
      // Every queue before any session: a session closing below must not let another conversation's
      // turn start, and no write may wait on a session that is slow to stop.
      for (const [shapeId, rt] of runtimes) {
        rt.idle?.cancel();
        rt.idle = null;
        for (const turn of rt.queue.splice(0)) notice(shapeId, turn.neverRan);
      }
      for (const rt of runtimes.values()) await closeLive(rt, 'stopped');
    },
  };
}
