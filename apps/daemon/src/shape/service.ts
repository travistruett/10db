import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ConflictError,
  ConversationItemKind,
  ConversationProfile,
  EventType,
  InvalidError,
  shapeFileRefusal,
  NotFoundError,
  parseItemBody,
  ShapeEventKind,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeOrigin,
  ShapeProposalState,
  type AccountKind,
  type ConversationId,
  type ConversationItemId,
  type DecisionId,
  type Effort,
  type GoalId,
  type PrincipleId,
  type ProjectId,
  type ShapeDto,
  ShapeFileKind,
  type ShapeFileDto,
  type ShapeFindingId,
  type ShapeAcceptId,
  type ShapeAttachmentId,
  type ShapeId,
  type ShapeMessageDto,
  type ShapeModelsDto,
  type MilestoneCut,
  type ShapeProposalId,
  type ShapeStartCountsDto,
  type ShapeViewDto,
  type StartShapeInput,
} from '@10db/contracts';
import {
  countShapeFiles,
  findShapeLinkOfGoal,
  getOneWayPaths,
  getProject,
  getShape,
  getShapeFinding,
  getShapeProposal,
  insertPlanSession,
  openChats,
  patchConversation,
  planOfConversation,
  insertShapeFile,
  insertShapeMessage,
  listConversationsOfProfile,
  listPushedTurnStarters,
  listQueuedTurnStarters,
  listShapes,
  patchShape,
  setOneWayPaths as setOneWayPathsRow,
  setShapeAttachmentApproved,
  settleOpenQuestionsOfTask,
  shapeConversation,
  type WriteContext,
} from '@10db/db';
import type { Clock } from '../clock';
import {
  createExploreEngine,
  keepPdfText,
  pictureLimitsFor,
  STRICTEST_LIMITS,
  type ExploreEngine,
  type PictureLimits,
} from '../conversation';
import { createEventBus, createLiveFrames, type StateStore } from '../events';
import type { Logger } from '../log';
import type { Pictures } from '../pictures';
import { mintSessionToken, type ShapeToolsFor } from '../mcp';
import type { AgentAdapter } from '../sessions';
import type { Hold } from '../verify';
import type { ScreenService } from '../screens';
import {
  effectiveOneWayPaths,
  gitTrackedFiles,
  oneWayNamesOf,
  type TrackedFiles,
} from './ceremony';
import { convertProposals, type ConvertOutcome, type JoiningProblem } from './convert';
import { checkDroppedFile, readyToKeep, storeFile } from './dropped-files';
import { dropNote, editNote, restoreNote, rowLabel, unpinNote } from './edit-notes';
import { designTargets, runDesignReview } from './design-review';
import { createPlanParts, type PlanParts, type PlanTurnState } from './plan-parts';
import type { ShapeJev } from './jev';
import { rehearseNote, reviewNote } from './policy';
import {
  dismissFinding as dismissRow,
  editedTaskKeys,
  reviewEfforts,
  unrehearsedTasks,
} from './review';
import {
  dropProposal as dropRow,
  editProposal as editRow,
  restoreProposal as restoreRow,
  unpinProposal as unpinRow,
} from './rounds';
import type { ShapeLaunch } from './session-launch';
import { createShapeToolHandlers, type ShapeToolDeps } from './tools';
import {
  removeDraftGoalOf,
  undoAccept,
  withdrawConvertedDecision,
  withdrawConvertedPrinciple,
  type UndoneAccept,
} from './undo';
import { buildStartCounts } from './preview';
import { buildShapeView, fileDtoOf, type ViewWorld } from './view';

// Shape spec §5.1, §5.3, §6, §11. A Plan conversation: its rows, presses and Convert, over the explore
// engine (sessions spec §6.1), which runs its session as the owner `explore-owner.ts` describes.

export type { ShapeLaunch, ShapePrepared, ShapePrepareInput } from './session-launch';

export interface ShapeServiceDeps {
  readonly state: StateStore;
  readonly adapter: AgentAdapter;
  /**
   * The explore engine that runs each conversation's session (sessions spec §6.1); Plan registers as
   * its owner. Absent, the service runs one of its own over `adapter`, `clock` and `hold`.
   */
  readonly engine?: ExploreEngine;
  readonly clock: Clock;
  readonly log: Logger;
  /** Takes the planning rules a chat's session is owed, once; see `ShapeToolDeps.owedRules`. */
  readonly owedRules?: ShapeToolDeps['owedRules'];
  /** The review turn a chat's session is in; see `ShapeToolDeps.reviewOf`. */
  readonly reviewOf?: ShapeToolDeps['reviewOf'];
  /** Whether a chat's session runs no subagents; see `ShapeToolDeps.noSubagents`. */
  readonly noSubagents?: ShapeToolDeps['noSubagents'];
  /**
   * The conversation's open session, when it does Plan's reviews itself: whether it has one live. Null
   * for a session with subagents or none open.
   */
  readonly reviewBusy?: (conversationId: ConversationId) => boolean | null;
  /**
   * Resolves a project's launch, on `model` (an ID the account lists) or, with null, on the `plan`
   * role's, at the conversation's own `effort` or, with null, the role's; throws when its account can't
   * start a session.
   */
  launch(projectId: ProjectId, model: string | null, effort: Effort | null): ShapeLaunch;
  /** The models a conversation of the project may run on (§5.1); none offered without it. */
  readonly models?: (projectId: ProjectId) => ShapeModelsDto;
  /** Where each conversation's dropped files are kept: `<filesDir>/<shape>`. */
  readonly filesDir: string;
  /** The starter's read of a pending join, which Convert refuses a change of areas over. */
  readonly joiningProblem: JoiningProblem;
  /** How long a session idles before its process closes; 10 minutes. */
  readonly idleMs?: number;
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
  /** Holds new turns back, as a waiting update's drain does; given to the engine the service runs. */
  readonly hold?: Hold;
  /** Draws a mock-up and shoots the app's pages for a Design review; absent, the press is refused. */
  readonly pictures?: Pick<Pictures, 'shootNow' | 'drawMockup'>;
}

/** A file as the input hands it over: the name the browser reported, and its bytes. */
export interface DroppedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface ShapeService {
  /**
   * `start_shape` (spec §5.6): a conversation from a terminal session, its summary the builder's first
   * message and its text files kept. Starts no turn.
   */
  startFromTerminal(input: StartShapeInput): ShapeDto;
  /**
   * Keeps a dropped file (§5.4) and sends it with the next message: an image as an image block, any
   * other file as a line naming its path. Throws InvalidError, naming the file, when it is refused.
   */
  addFile(shapeId: ShapeId, file: DroppedFile): Promise<ShapeFileDto>;
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
   * Plan review: queues a turn in which the session has each goal and loose task (`proposalIds` when
   * given, else every pending one) reviewed for scope and engineering, by the reviewers where it has
   * them and itself where it has none. `running` when a review turn is already queued or running.
   */
  review(
    shapeId: ShapeId,
    proposalIds?: readonly ShapeProposalId[],
  ): { status: 'started' | 'running' | 'nothing'; tasks: number };
  /**
   * Design review: for each pending task (`proposalIds` when given) that has a mock-up and a page area,
   * draws the mock-up and shoots the page as it is now, then queues a turn in which the session has them
   * compared with the app and the project's `DESIGN.md`. `nothing` when no task has both; `running` while
   * a review press waits or its turn runs, or the pictures are still being taken.
   */
  designReview(
    shapeId: ShapeId,
    proposalIds?: readonly ShapeProposalId[],
  ): Promise<{ status: 'started' | 'running' | 'nothing'; tasks: number }>;
  /** Approves a mock-up as the design target, or takes the approval back; a note tells the session. */
  approveAttachment(shapeId: ShapeId, attachmentId: ShapeAttachmentId, approved: boolean): void;
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
  /**
   * Undo Accept: takes back the plan's latest Accept in one write and never stops a run. Throws
   * InvalidError for an Accept undone or not the latest, ConflictError for a task that has a run.
   */
  undoAccept(shapeId: ShapeId, acceptId: ShapeAcceptId): UndoneAccept;
  /** What Accept and Start would do with these pending proposals: the confirm's counts. Writes nothing. */
  startCounts(shapeId: ShapeId, proposalIds: readonly ShapeProposalId[]): ShapeStartCountsDto;
  /** Withdraw Decision: a decision the conversation wrote, with the builder's reason. */
  withdrawDecision(shapeId: ShapeId, decisionId: DecisionId, reason: string): void;
  /**
   * Withdraw Principle: a principle the conversation wrote, with the builder's reason; the same
   * withdrawal the knowledge routes make. Throws ConflictError once a later principle replaced it.
   */
  withdrawPrinciple(shapeId: ShapeId, principleId: PrincipleId, reason: string): void;
  /**
   * Converts the selected proposals in one write; a turn that runs goes on. A Plan with more than five
   * milestones waiting needs the builder's `cut` of them (`judgeMilestones`).
   */
  convert(
    shapeId: ShapeId,
    proposalIds: readonly ShapeProposalId[],
    options?: { cut?: readonly MilestoneCut[] },
  ): Promise<ConvertOutcome>;
  /** The handlers the MCP endpoint serves a conversation's session. */
  readonly toolsFor: ShapeToolsFor;
  /** What a chat with a plan adds to its session, which the chat's hooks compose. */
  readonly planParts: PlanParts;
  /** Jev's shadow decisions hear a builder message of a chat with a plan; it never throws. */
  heard(conversationId: ConversationId, itemId: ConversationItemId): void;
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
  /** Stops every session; what was queued waits under Send now at the next start. */
  close(): Promise<void>;
}

/** How long a checkout's tracked files are reused before git is asked again. */
const TRACKED_FILES_TTL_MS = 30_000;
/** How long a conversation the service runs waits out a rate limit that names no reset. */
const DEFAULT_PAUSE_MS = 30 * 60_000;

export function createShapeService(deps: ShapeServiceDeps): ShapeService {
  const { state, clock, log } = deps;
  const engine =
    deps.engine ??
    createExploreEngine({
      state,
      adapter: deps.adapter,
      clock,
      log,
      dataDir: deps.filesDir,
      frames: createLiveFrames(),
      bus: createEventBus(),
      mintToken: mintSessionToken,
      accountBlocked: () => null,
      defaultPauseMs: DEFAULT_PAUSE_MS,
      ...(deps.hold === undefined ? {} : { hold: deps.hold }),
      ...(deps.idleMs === undefined ? {} : { idleMs: deps.idleMs }),
    });
  const turns = new Map<ShapeId, PlanTurnState>();
  const turnOf = (shapeId: ShapeId): PlanTurnState => {
    let turn = turns.get(shapeId);
    if (turn === undefined) {
      turn = { notes: [] };
      turns.set(shapeId, turn);
    }
    return turn;
  };
  const conversationOf = (shapeId: ShapeId): ConversationId =>
    shapeConversation(state.db, shapeId).id;
  /** A turn is in progress: the session is starting, running, waiting on a card or stopping. */
  const turnRuns = (conversation: ConversationId): boolean => engine.busy().includes(conversation);
  /** The explore conversations of the chats that have a plan. */
  const planConversations = () =>
    listConversationsOfProfile(state.db, ConversationProfile.Explore).flatMap((c) => {
      const shapeId = planOfConversation(state.db, c.id);
      return shapeId === null ? [] : [{ conversation: c, shapeId }];
    });
  /**
   * A session that does Plan's reviews itself takes one at a time: a press of either kind is refused while
   * another review press waits or its turn runs, so two reviews never share a turn there.
   */
  const reviewInSessionBusy = (shapeId: ShapeId): boolean => {
    const busy = deps.reviewBusy?.(conversationOf(shapeId)) ?? null;
    return (
      busy !== null &&
      (busy ||
        pressPending(shapeId, ShapeEventKind.Review) ||
        pressPending(shapeId, ShapeEventKind.Rehearse) ||
        pressPending(shapeId, ShapeEventKind.DesignReview))
    );
  };
  /** The plans whose Design review is taking its pictures. */
  const takingPictures = new Set<ShapeId>();
  /** A press of `kind` waits or runs: queued, or handed to a session and not taken yet. */
  const pressPending = (shapeId: ShapeId, kind: ShapeEventKind): boolean => {
    const conversation = conversationOf(shapeId);
    return [
      ...listQueuedTurnStarters(state.db, conversation),
      ...listPushedTurnStarters(state.db, conversation),
    ].some(
      (item) =>
        item.kind === ConversationItemKind.ShapeEvent &&
        parseItemBody(item.kind, item.body).kind === kind,
    );
  };
  const say = (
    shapeId: ShapeId,
    author: ShapeMessageAuthor,
    kind: ShapeMessageKind,
    body: string,
  ): ShapeMessageDto =>
    state.write((ctx) => insertShapeMessage(ctx, shapeId, { author, kind, body }));

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
  const { screens } = deps;
  const toolsFor: ShapeToolsFor = (chat) =>
    createShapeToolHandlers(
      {
        state,
        // A screen is held to the limits of the account the session that asked for it runs on.
        ...(screens === undefined
          ? {}
          : {
              screens: {
                see: (id, input) => screens.see(id, input, launchLimits(id)),
              },
            }),
        world: worldOfShape,
        ...(deps.owedRules === undefined ? {} : { owedRules: deps.owedRules }),
        ...(deps.reviewOf === undefined ? {} : { reviewOf: deps.reviewOf }),
        ...(deps.noSubagents === undefined ? {} : { noSubagents: deps.noSubagents }),
      },
      chat,
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
    if (note !== null) turnOf(shapeId).notes.push(note);
  };

  // PDFs whose text is being read, and those read at least once this run, by stored path.
  const pdfReading = new Set<string>();
  const pdfTried = new Set<string>();
  let shuttingDown = false;

  /** Reads a PDF's text after the upload has answered; it only logs, and writes nothing once closing. */
  const readPdfText = (storedPath: string, name: string, bytes: Uint8Array): void => {
    pdfReading.add(storedPath);
    pdfTried.add(storedPath);
    void keepPdfText(storedPath, bytes, () => !shuttingDown && existsSync(dirname(storedPath)))
      .then((written) => {
        if (written === null) log.info({ file: name }, 'a dropped PDF has no text');
      })
      .catch((error: unknown) => {
        log.warn({ err: error, file: name }, 'a dropped PDF’s text could not be read');
      })
      .finally(() => {
        pdfReading.delete(storedPath);
      });
  };

  /**
   * Whether a PDF's text is on its way. A PDF with no text file that this run never read (the daemon
   * restarted in the middle of reading it) is read again, once.
   */
  const pdfTextComing = (storedPath: string, name: string): boolean => {
    if (pdfReading.has(storedPath)) return true;
    if (pdfTried.has(storedPath) || shuttingDown) return false;
    try {
      readPdfText(storedPath, name, readFileSync(storedPath));
      return true;
    } catch (error) {
      pdfTried.add(storedPath);
      log.warn({ err: error, file: name }, 'a dropped PDF could not be read again');
      return false;
    }
  };

  const planParts = createPlanParts({
    state,
    log,
    filesDir: deps.filesDir,
    turnOf,
    announce,
    pdfTextComing,
  });

  return {
    startFromTerminal(input) {
      const made: { id: ShapeId | null } = { id: null };
      try {
        return state.write((ctx) => {
          const { shape } = insertPlanSession(ctx, {
            projectId: input.projectId,
            title: input.title,
            origin: ShapeOrigin.ClaudeCode,
            tabPosition: openChats(ctx.tx).length,
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
              bytes,
              held: countShapeFiles(ctx.tx, shape.id),
            });
            // Inline files are text by construction; one that reads as anything else is refused.
            if (
              checked.mediaType !== ShapeFileKind.Text &&
              checked.mediaType !== ShapeFileKind.Markdown
            )
              throw new InvalidError(`${checked.name} isn't a text file`);
            insertShapeFile(ctx, {
              shapeId: shape.id,
              name: checked.name,
              mediaType: checked.mediaType,
              size: checked.bytes.length,
              storedPath: storeFile(deps.filesDir, shape.id, checked.storedName, checked.bytes),
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

    async addFile(shapeId, file) {
      getShape(state.db, shapeId);
      const checked = await readyToKeep(
        checkDroppedFile({
          name: file.name,
          bytes: file.bytes,
          held: countShapeFiles(state.db, shapeId),
        }),
      );
      const storedPath = storeFile(deps.filesDir, shapeId, checked.storedName, checked.bytes);
      try {
        const row = state.write((ctx) => {
          // Counted again here: drops that overlap each passed the first count.
          const refusal = shapeFileRefusal({
            name: checked.name,
            size: checked.bytes.length,
            held: countShapeFiles(ctx.tx, shapeId),
          });
          if (refusal !== null) throw new InvalidError(refusal);
          return insertShapeFile(ctx, {
            shapeId,
            name: checked.name,
            mediaType: checked.mediaType,
            size: checked.bytes.length,
            storedPath,
          });
        });
        if (checked.mediaType === ShapeFileKind.Pdf)
          readPdfText(storedPath, checked.name, checked.bytes);
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

    rehearse(shapeId, proposalIds) {
      const tasks = unrehearsedTasks(state.db, shapeId, proposalIds);
      if (tasks.length === 0) return { status: 'nothing', tasks: 0 };
      if (pressPending(shapeId, ShapeEventKind.Rehearse) || reviewInSessionBusy(shapeId))
        return { status: 'running', tasks: tasks.length };
      const { note, instruction, inSession } = rehearseNote(tasks);
      // The note is a row in the transcript, and the turn lists each task at the hash it was read at.
      state.write((ctx) =>
        insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Note,
          kind: ShapeMessageKind.Rehearse,
          body: note,
          prompt: instruction,
          promptInSession: inSession,
          rehearsing: tasks.map((t) => ({ taskKey: t.taskKey, hash: t.hash })),
        }),
      );
      engine.queued(conversationOf(shapeId));
      return { status: 'started', tasks: tasks.length };
    },

    review(shapeId, proposalIds) {
      const rows = reviewEfforts(state.db, shapeId, proposalIds);
      if (rows.length === 0) return { status: 'nothing', tasks: 0 };
      if (pressPending(shapeId, ShapeEventKind.Review) || reviewInSessionBusy(shapeId))
        return { status: 'running', tasks: rows.length };
      const { note, instruction, inSession } = reviewNote(rows);
      state.write((ctx) =>
        insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Note,
          kind: ShapeMessageKind.Review,
          body: note,
          prompt: instruction,
          promptInSession: inSession,
        }),
      );
      engine.queued(conversationOf(shapeId));
      return { status: 'started', tasks: rows.length };
    },

    async designReview(shapeId, proposalIds) {
      const { projectId } = getShape(state.db, shapeId);
      const project = getProject(state.db, projectId);
      const targets = designTargets(state.db, shapeId, project.areas, proposalIds);
      if (targets.length === 0 || deps.pictures === undefined)
        return { status: 'nothing', tasks: 0 };
      if (
        takingPictures.has(shapeId) ||
        pressPending(shapeId, ShapeEventKind.DesignReview) ||
        reviewInSessionBusy(shapeId)
      )
        return { status: 'running', tasks: targets.length };
      takingPictures.add(shapeId);
      try {
        await runDesignReview(
          { state, pictures: deps.pictures, planFilesDir: (id) => join(deps.filesDir, id) },
          shapeId,
          project,
          targets,
          (line) => {
            say(shapeId, ShapeMessageAuthor.Note, ShapeMessageKind.Notice, line);
          },
        );
      } finally {
        takingPictures.delete(shapeId);
      }
      engine.queued(conversationOf(shapeId));
      return { status: 'started', tasks: targets.length };
    },

    approveAttachment(shapeId, attachmentId, approved) {
      state.write((ctx) => {
        setShapeAttachmentApproved(ctx, shapeId, attachmentId, approved);
      });
      turnOf(shapeId).notes.push(
        approved
          ? 'The builder approved a mock-up as the design target.'
          : 'The builder took back the approval of a mock-up.',
      );
    },

    resume(shapeId, event) {
      getShape(state.db, shapeId);
      const message = say(shapeId, ShapeMessageAuthor.Note, ShapeMessageKind.Event, event);
      // Only the event: every turn works out what Convert made as it starts, so a note queued here
      // would go stale before it was sent.
      turnOf(shapeId).notes.push(`[m:${message.id}] ${event}`);
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
      turnOf(shapeId).notes.push(note);
    },

    chooseModel(shapeId, model, effort = null) {
      const { projectId } = getShape(state.db, shapeId);
      const offered = (deps.models?.(projectId).offered ?? []).map((o) => o.model);
      if (model !== null && !offered.includes(model))
        throw new InvalidError(
          `${model} is not a model this project's account offers; choose one of ${offered.join(', ') || 'none'}.`,
        );
      const conversation = conversationOf(shapeId);
      if (turnRuns(conversation) || engine.view(conversation).queued > 0)
        throw new ConflictError(
          'The model changes between turns: wait for the turn to end, or stop it, then choose again.',
        );
      const shape = state.write((ctx) => {
        patchConversation(ctx, shapeConversation(ctx.tx, shapeId).id, { effort });
        return patchShape(ctx, shapeId, {});
      });
      // The engine switches a warm session for its next turn, and notes the change once it has.
      void engine
        .modelChanged(conversation, model)
        .then(
          () => {
            announce(shapeId);
          },
          (error: unknown) => {
            log.warn({ err: error, shapeId }, 'the conversation’s model could not be changed');
            // The old pick is back: the screen shows it again.
            announce(shapeId);
          },
        )
        // A change that settles once the store has closed has no screen left to tell.
        .catch((error: unknown) => {
          log.warn({ err: error, shapeId }, 'the conversation’s model change could not be shown');
        });
      return { ...shape, model };
    },

    view(shapeId) {
      const conversation = conversationOf(shapeId);
      const live = engine.view(conversation);
      return buildShapeView(
        state.db,
        shapeId,
        {
          running: turnRuns(conversation),
          queued: live.queued,
          proposing: pressPending(shapeId, ShapeEventKind.Propose),
          rehearsing: pressPending(shapeId, ShapeEventKind.Rehearse),
          waitingForUpdate: engine.parked(conversation) && live.queued > 0,
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

    undoAccept(shapeId, acceptId) {
      return state.write((ctx) => undoAccept(ctx, shapeId, acceptId));
    },

    startCounts(shapeId, proposalIds) {
      return buildStartCounts(state.db, shapeId, proposalIds, clock.now());
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
      await engine.stop(conversationOf(shapeId));
    },

    convert(shapeId, proposalIds, options) {
      // One write: a turn that runs goes on, and reads the rows as they stand when it next looks.
      return Promise.resolve(
        state.write((ctx) => {
          const outcome = convertProposals(
            ctx,
            shapeId,
            proposalIds,
            deps.joiningProblem,
            options?.cut,
          );
          if (outcome.ok && outcome.createdNow > 0)
            insertShapeMessage(ctx, shapeId, {
              author: ShapeMessageAuthor.Note,
              kind: ShapeMessageKind.Event,
              body: `Converted ${String(outcome.createdNow)} ${outcome.createdNow === 1 ? 'proposal' : 'proposals'}`,
            });
          return outcome;
        }),
      );
    },

    toolsFor,
    planParts,
    heard(conversationId, itemId) {
      const shapeId = planOfConversation(state.db, conversationId);
      if (shapeId !== null) void deps.jev?.heard(shapeId, itemId);
    },
    settled: (shapeId) => engine.settled(conversationOf(shapeId)),

    turnsInProgress() {
      // A conversation counts once: a turn running, or a starter parked behind a drain.
      return planConversations().filter(
        ({ conversation: c }) =>
          turnRuns(c.id) || (engine.parked(c.id) && engine.view(c.id).queued > 0),
      ).length;
    },

    runningTurns() {
      return planConversations()
        .filter(({ conversation: c }) => turnRuns(c.id))
        .map(({ shapeId }) => ({ id: shapeId, title: getShape(state.db, shapeId).title }));
    },

    async close() {
      shuttingDown = true;
      await engine.close();
    },
  };
}
