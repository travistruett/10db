import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConflictError,
  ConversationItemKind,
  ConversationOwnerKind,
  ConversationProfile,
  EventType,
  InvalidError,
  NotFoundError,
  parseItemBody,
  ShapeEventKind,
  ShapeId,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeOrigin,
  ShapeProposalState,
  type AccountKind,
  type ConversationId,
  type DecisionId,
  type Effort,
  type GoalId,
  type PrincipleId,
  type ProjectId,
  type ShapeDto,
  type ShapeFileDto,
  type ShapeFindingId,
  type ShapeMessageDto,
  type ShapeModelsDto,
  type MilestoneCut,
  type ShapeProposalId,
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
  getItem,
  getShapeProposal,
  DEFAULT_SHAPE_TITLE,
  insertPlanSession,
  patchConversation,
  insertShapeFile,
  insertShapeMessage,
  listConversationsOfProfile,
  listPushedTurnStarters,
  listQueuedTurnStarters,
  listShapes,
  patchShape,
  setOneWayPaths as setOneWayPathsRow,
  settleOpenQuestionsOfTask,
  shapeConversation,
  updateItem,
  type ConversationItemRow,
  type WriteContext,
} from '@10db/db';
import type { Clock } from '../clock';
import {
  createExploreEngine,
  pictureLimitsFor,
  STRICTEST_LIMITS,
  type ExploreEngine,
  type PictureLimits,
} from '../conversation';
import { createEventBus, createLiveFrames, type StateStore } from '../events';
import type { Logger } from '../log';
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
import { checkDroppedFile, storeFile } from './dropped-files';
import { dropNote, editNote, restoreNote, rowLabel, unpinNote } from './edit-notes';
import { createShapeOwner, type ShapeTurnState } from './explore-owner';
import type { Judge } from '../judge';
import type { ShapeJev } from './jev';
import { proposeNote, rehearseNote } from './policy';
import { dismissFinding as dismissRow, editedTaskKeys, unrehearsedTasks } from './review';
import {
  dropProposal as dropRow,
  editProposal as editRow,
  restoreProposal as restoreRow,
  unpinProposal as unpinRow,
} from './rounds';
import type { ShapeLaunch, ShapePrepared, ShapePrepareInput } from './session-launch';
import { createShapeToolHandlers } from './tools';
import { removeDraftGoalOf, withdrawConvertedDecision, withdrawConvertedPrinciple } from './undo';
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
  /** 10db's judge, for Plan on an account auto mode doesn't judge; absent, such a session is on the rules. */
  readonly judge?: Judge;
  readonly log: Logger;
  readonly mcp: { readonly url: string; readonly toolTimeoutMs: number };
  /**
   * Resolves a project's launch, on `model` (an ID the account lists) or, with null, on the `plan`
   * role's, at the conversation's own `effort` or, with null, the role's; throws when its account can't
   * start a session.
   */
  launch(projectId: ProjectId, model: string | null, effort: Effort | null): ShapeLaunch;
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
  /** Holds new turns back, as a waiting update's drain does; given to the engine the service runs. */
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
  /** Stop and Redo: the turn stops, and the edited message runs next in place of the one it redoes. */
  redo(shapeId: ShapeId, text: string): Promise<ConversationItemRow>;
  /** Sends what waits under the conversation's Send now line. */
  sendNow(shapeId: ShapeId): void;
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
   * caller asks to interrupt it. Holds the queue while it writes. A Plan with more than five milestones
   * waiting needs the builder's `cut` of them (`judgeMilestones`).
   */
  convert(
    shapeId: ShapeId,
    proposalIds: readonly ShapeProposalId[],
    options?: { interrupt?: boolean; cut?: readonly MilestoneCut[] },
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
  /** Stops every session; what was queued waits under Send now at the next start. */
  close(): Promise<void>;
}

const TITLE_MAX = 60;

/** The first non-empty line of a message, cut to fit a title. */
function titleFrom(text: string): string {
  const line = (text.split('\n').find((l) => l.trim() !== '') ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/** How long a checkout's tracked files are reused before git is asked again. */
const TRACKED_FILES_TTL_MS = 30_000;
/** The share of the context window past which a conversation moves to a fresh session. */
const CONTEXT_LIMIT_PCT = 70;
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
  const turns = new Map<ShapeId, ShapeTurnState>();
  const turnOf = (shapeId: ShapeId): ShapeTurnState => {
    let turn = turns.get(shapeId);
    if (turn === undefined) {
      turn = { notes: [], proposed: false, emptyPlan: false, refused: 0 };
      turns.set(shapeId, turn);
    }
    return turn;
  };
  const conversationOf = (shapeId: ShapeId): ConversationId =>
    shapeConversation(state.db, shapeId).id;
  /** A turn is in progress: the session is starting, running, waiting on a card or stopping. */
  const turnRuns = (conversation: ConversationId): boolean => engine.busy().includes(conversation);
  /** The explore conversations Plan owns. */
  const planConversations = () =>
    listConversationsOfProfile(state.db, ConversationProfile.Explore).filter(
      (c) => c.ownerKind === ConversationOwnerKind.Shape,
    );
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
  /** Queued presses of `kind` stop being turn starters: their notes stay in the transcript. */
  const dropQueuedPresses = (conversation: ConversationId, kind: ShapeEventKind): void => {
    state.write((ctx) => {
      for (const item of listQueuedTurnStarters(ctx.tx, conversation)) {
        if (item.kind !== ConversationItemKind.ShapeEvent) continue;
        const press = parseItemBody(item.kind, item.body);
        // The note stays in the transcript; without its instruction it starts no turn.
        if (press.kind === kind)
          updateItem(ctx, item.id, { body: { kind: press.kind, text: press.text } });
      }
    });
  };

  const say = (
    shapeId: ShapeId,
    author: ShapeMessageAuthor,
    kind: ShapeMessageKind,
    body: string,
  ): ShapeMessageDto =>
    state.write((ctx) => insertShapeMessage(ctx, shapeId, { author, kind, body }));
  /** Tells the screen the conversation changed, for what no row records (where its session is). */
  /**
   * The builder's message, stored queued before anything is sent: it waits for a turn to
   * take it. The first one titles the conversation.
   */
  const postMessage = (shapeId: ShapeId, text: string): ShapeMessageDto => {
    const message = state.write((ctx) =>
      insertShapeMessage(ctx, shapeId, {
        author: ShapeMessageAuthor.Builder,
        kind: ShapeMessageKind.Text,
        body: text,
        queued: true,
      }),
    );
    const title = titleFrom(text);
    if (title !== '' && getShape(state.db, shapeId).title === DEFAULT_SHAPE_TITLE)
      state.write((ctx) => {
        patchShape(ctx, shapeId, { title });
      });
    return message;
  };
  /** Shadow only: nothing waits on it, and it never throws. */
  const heard = (shapeId: ShapeId, message: ShapeMessageDto): void => {
    void deps.jev?.heard(shapeId, message.id);
  };

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
  const toolsFor: ShapeToolsFor = ({ shapeId }) =>
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
        onProposal: (id, accepted, empty = false) => {
          const rt = turnOf(id);
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
    if (note !== null) turnOf(shapeId).notes.push(note);
  };

  engine.register(
    ConversationOwnerKind.Shape,
    createShapeOwner({
      state,
      log,
      mcp: deps.mcp,
      filesDir: deps.filesDir,
      launch: (projectId, model, effort) => deps.launch(projectId, model, effort),
      ...(deps.prepare === undefined ? {} : { prepare: deps.prepare }),
      limitsFor,
      judgeOf: (kind, model) => deps.adapter.capabilities({ kind }, model).judge,
      subagentsOf: (kind, model) => deps.adapter.capabilities({ kind }, model).subagents,
      ...(deps.judge === undefined ? {} : { judge: deps.judge }),
      clock: deps.clock,
      contextLimitPct: deps.contextLimitPct ?? CONTEXT_LIMIT_PCT,
      turnOf,
      announce,
    }),
  );

  return {
    create(projectId, input) {
      return state.write(
        (ctx) =>
          insertPlanSession(ctx, {
            projectId,
            title: input.title === DEFAULT_SHAPE_TITLE ? null : input.title,
            origin: input.origin,
            tabPosition: null,
          }).shape,
      );
    },

    startFromTerminal(input) {
      const made: { id: ShapeId | null } = { id: null };
      try {
        return state.write((ctx) => {
          const { shape } = insertPlanSession(ctx, {
            projectId: input.projectId,
            title: input.title,
            origin: ShapeOrigin.ClaudeCode,
            tabPosition: null,
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
      const message = postMessage(shapeId, text);
      engine.queued(conversationOf(shapeId));
      heard(shapeId, message);
      return message;
    },

    redo(shapeId, text) {
      const posted: { message: ShapeMessageDto | null } = { message: null };
      return engine
        .redo(conversationOf(shapeId), () => {
          const message = postMessage(shapeId, text);
          posted.message = message;
          return getItem(state.db, message.id);
        })
        .then((edit) => {
          if (posted.message !== null) heard(shapeId, posted.message);
          return edit;
        });
    },

    sendNow(shapeId) {
      engine.sendNow(conversationOf(shapeId));
    },

    propose(shapeId) {
      if (pressPending(shapeId, ShapeEventKind.Propose)) return { status: 'ignored' };
      const { note, instruction } = proposeNote(getShape(state.db, shapeId).round > 0);
      // The press is a row in the transcript; its
      // instruction makes it a turn starter, queued.
      state.write((ctx) => {
        insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Note,
          kind: ShapeMessageKind.Propose,
          body: note,
          prompt: instruction,
        });
      });
      engine.queued(conversationOf(shapeId));
      return { status: 'started' };
    },

    rehearse(shapeId, proposalIds) {
      const tasks = unrehearsedTasks(state.db, shapeId, proposalIds);
      if (tasks.length === 0) return { status: 'nothing', tasks: 0 };
      if (pressPending(shapeId, ShapeEventKind.Rehearse))
        return { status: 'running', tasks: tasks.length };
      const { note, instruction } = rehearseNote(tasks);
      // The note is a row in the transcript, and the turn lists each task at the hash it was read at.
      state.write((ctx) =>
        insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Note,
          kind: ShapeMessageKind.Rehearse,
          body: note,
          prompt: instruction,
          rehearsing: tasks.map((t) => ({ taskKey: t.taskKey, hash: t.hash })),
        }),
      );
      engine.queued(conversationOf(shapeId));
      return { status: 'started', tasks: tasks.length };
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

    async convert(shapeId, proposalIds, options) {
      const conversation = conversationOf(shapeId);
      if (options?.interrupt === true) {
        // Convert Anyway stops the rehearsal (spec §7), queued as well as running: one left queued
        // would read proposals that are no longer pending once the hold is released.
        dropQueuedPresses(conversation, ShapeEventKind.Rehearse);
      }
      if (turnRuns(conversation)) {
        if (options?.interrupt !== true)
          throw new ConflictError('The agent is still answering; Stop or wait');
        engine.holdStarts(conversation);
        await engine.stop(conversation);
        await engine.settled(conversation);
      }
      engine.holdStarts(conversation);
      try {
        return state.write((ctx) => {
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
        });
      } finally {
        engine.releaseStarts(conversation);
      }
    },

    toolsFor,
    settled: (shapeId) => engine.settled(conversationOf(shapeId)),

    turnsInProgress() {
      // A conversation counts once: a turn running, or a starter parked behind a drain.
      return planConversations().filter(
        (c) => turnRuns(c.id) || (engine.parked(c.id) && engine.view(c.id).queued > 0),
      ).length;
    },

    runningTurns() {
      return planConversations()
        .filter((c) => turnRuns(c.id))
        .map((c) => {
          const id = ShapeId.parse(c.ownerId);
          return { id, title: getShape(state.db, id).title };
        });
    },

    async close() {
      await engine.close();
    },
  };
}
