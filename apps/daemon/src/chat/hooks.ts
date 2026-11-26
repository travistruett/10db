import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ConversationItemId, SessionId, ShapeId } from '@10db/contracts';
import {
  ChatToolName,
  FolderAsker,
  JudgeDecision,
  JudgeKind,
  CHAT_DEFAULT_TITLE,
  ConversationId,
  FolderHolderKind,
  ConversationItemAuthor,
  ConversationItemKind,
  DeniedBy,
  ShapeEventKind,
  parseItemBody,
  InvalidError,
  Provider,
  ShapeToolName,
  TrustSurface,
  AccountKind,
  type Effort,
  type ProjectDto,
  type ProjectId,
  type TrustPolicy,
  type ChatId,
  WorkPlace,
} from '@10db/contracts';
import {
  chatOfConversation,
  getChat,
  getConversation,
  getProject,
  getItem,
  insertItem,
  listFiles,
  listItemFiles,
  listItems,
  planIdOfChat,
  planOfConversation,
  touchChat,
  type ConversationItemRow,
  type ChatRow,
  type ConversationRow,
} from '@10db/db';
import {
  BUSY,
  heldInlineBytes,
  outgoingMessage,
  type DeliverableMessage,
  type ExploreOwnerHooks,
  type PictureLimits,
} from '../conversation';
import { storedModelNames } from '../catalogue';
import type { AccountAgent } from '../environment';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import { holderWords, type FolderBlocker, type FolderHold } from '../folder-hold';
import type { CommittedReader, ComposeServices } from '../folders';
import { createHookJudge, createLimitNotes } from '../inbox';
import type { Judge } from '../judge';
import { principlesBrief } from '../knowledge';
import type { Logger } from '../log';
import { trustSwitchesFor, warnInvalidTrust } from '../permissions';
import { TOOL_PICTURES_CAPTION, type ToolImages } from '../mcp';
import {
  fullAccessSettings,
  type ExploreProfile,
  type FullAccessSettings,
  type SessionHandle,
  type ShapeToolRequest,
} from '../sessions';
import {
  owedPlanningRules,
  PLANNING_STUB,
  ReviewTurnKind,
  reviewsAfterTurnEnd,
  type ShapeReviewTurn,
  type PlanParts,
  type ShapeAccess,
  type ShapeLaunch,
  type ShapePrepared,
  type ShapePrepareInput,
} from '../shape';
import {
  buildTrustPolicy,
  FloorReason,
  floorNoticeText,
  floorWhy,
  judgeForCall,
  projectGrantLines,
  projectLiveSystems,
  sessionDevAccess,
  startingJudge,
} from '../trust';
import { digestText } from './brief';
import {
  judgeChatCall,
  judgeFullAccessCall,
  outsideSandboxRefusal,
  type ChatPlace,
} from './confinement';
import { workNote } from './work-note';
import { chatRoot, withWorktreeOnDisk } from './work-root';
import { JUDGED_CHAT_TOOLS } from './git-rule';
import type { ChatLiveSessions } from './live-sessions';
import { chatSystemPrompt } from './prompt';
import { startsBackground } from './background-start';
import { couldChange } from './first-change';

// Sessions spec §7.1, trust line §5: a chat as an owner of the explore engine. Its session is the
// explore profile as the attended one: Plan's read-only sandbox and read tools, commands judged, the
// web where a judge sees each call, Claude Code's own subagents, the builder's setup, and 10db's own
// server with every builder tool. It edits the checkout only while its turn holds Your folder.

/**
 * How long a turn's jobs get to stop before the session is closed instead: a process table that cannot be read
 * must not keep Your folder from the builder.
 */
export const JOBS_STOP_DEADLINE_MS = 30_000;

/** `work`, or a rejection once `ms` pass on `clock`; the timer is cleared when `work` settles first. */
function withDeadline<T>(work: Promise<T>, clock: Clock, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => {
      reject(new Error('stopping the jobs took too long'));
    }, ms);
    work.then(
      (value) => {
        timer.cancel();
        resolve(value);
      },
      (error: unknown) => {
        timer.cancel();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** The share of the context window past which a chat moves to a fresh session. */
export const CHAT_FRESH_AT_CONTEXT_PCT = 70;

/** What a Full access launch reads when the launch names no account facts: the builder's own folder, no key. */
const FULL_ACCESS_DEFAULTS = {
  apiKeyHelper: null,
  keyInEnv: false,
  defaultConfigDir: true,
} as const;

/**
 * A Codex chat's Full access as the spec carries it. Claude's mode, key helper and scrub mean nothing to Codex,
 * which reads only that the chat is Full access; its judge stays 10db's.
 */
const CODEX_FULL_ACCESS = {
  permissionMode: 'default',
  apiKeyHelper: null,
  scrub: false,
  ownSetup: false,
} as const;

/** How often a Full access turn's end looks for background tasks still running. */
export const BACKGROUND_POLL_MS = 1_000;

/** What a chat's session that has no sandbox answers a call it would have asked about. */
const NOTHING_TO_ASK = 'This chat has no sandbox, so it runs no command and asks for nothing.';

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Skill'] as const;
const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;
const AGENT_TOOLS = ['Task', 'Agent'] as const;
/** The file tools a chat edits with, judged on each call by whether its turn holds Your folder. */
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;
/** Named so that a built-in that watches without end never reaches a chat. */
const WATCH_TOOLS = ['Monitor'] as const;

/** Every chat tool as the session names it on 10db's own server. */
export const CHAT_MCP_TOOLS: readonly string[] = Object.values(ChatToolName).map(
  (name) => `mcp__10db__${name}`,
);

/** Every Plan tool as a session names it on 10db's own server. */
const PLAN_MCP_TOOLS: readonly string[] = Object.values(ShapeToolName).map(
  (name) => `mcp__10db__${name}`,
);

/**
 * A chat's tools by whether it has a sandbox to run commands in. The web tools stay out of
 * `allowedTools`: an allow rule would approve a call before auto mode's classifier sees it, and with
 * no judge the hook refuses them.
 */
export function chatProfile(
  sandboxed: boolean,
): Omit<ExploreProfile, 'kind' | 'systemPrompt' | 'judge'> {
  return {
    tools: [
      ...READ_TOOLS,
      ...WEB_TOOLS,
      ...AGENT_TOOLS,
      ...(sandboxed ? ['Bash', ...EDIT_TOOLS] : []),
    ],
    // The tools that reach GitHub are left off: an allow rule would approve them before any judge sees them.
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Skill',
      ...CHAT_MCP_TOOLS.filter((tool) => !JUDGED_CHAT_TOOLS.has(tool.slice('mcp__10db__'.length))),
      // Plan's tools never ask, and every session has them: the confinement judges who calls which, and a
      // session started before its plan could not gain them later.
      ...PLAN_MCP_TOOLS,
    ],
    disallowedTools: [...WATCH_TOOLS, ...(sandboxed ? [] : ['Bash', ...EDIT_TOOLS])],
    agents: {},
    // Only a session with the file tools can edit, so only it keeps file history.
    fileCheckpointing: sandboxed,
  };
}

/** Where a chat's pictures and full outputs are kept: a path made only from its id. */
export function chatFolder(dataDir: string, conversationId: ConversationId): string {
  return join(dataDir, 'conversations', ConversationId.parse(conversationId));
}

export interface ChatHooksDeps {
  readonly state: StateStore;
  /** Who holds Your folder: a chat's turn takes it, and writes only while it holds it. */
  readonly folderHold: FolderHold;
  /**
   * The checkout's HEAD and working tree as one value (`checkoutState`): a command the builder allowed again
   * outside the sandbox asks again once it moves.
   */
  readonly checkoutState: (checkout: string) => Promise<string>;
  /**
   * The sessions whose next start tells them they moved to a branch before their last change. The move adds a
   * chat; the start takes it, so it is said once and a restart drops it.
   */
  readonly firstStartAfterMove?: Set<ChatId>;
  readonly log: Logger;
  readonly dataDir: string;
  readonly now: () => Date;
  readonly mcp: { readonly url: string };
  /** Resolves a project's launch on `model` or, with null, on the `plan` role's, at `effort` or the model's own. */
  launch(projectId: ProjectId, model: string | null, effort: Effort | null): ShapeLaunch;
  readonly prepare?: (input: ShapePrepareInput) => Promise<ShapePrepared>;
  /**
   * Prepares a Full access chat's session: no sandbox, a broker with no file access, and, where `relay` is set,
   * the builder's setup as a sandboxed chat has it. Absent, such a session can ask for nothing.
   */
  readonly prepareFullAccess?: (
    input: ShapePrepareInput & { readonly relay: boolean },
  ) => Promise<ShapePrepared>;
  /** Parks the turn that is starting until Your folder can be the chat's; a Full access turn never runs without it. */
  readonly parkForFolder?: (chatId: ChatId) => void;
  /** Whether the SDK reports a background task still running for the conversation's open session. */
  readonly backgroundRunning?: (conversationId: ConversationId) => boolean;
  /** What a chat adds to its session for planning: its folder and agents always, and its prompt, intake and read budget once it has a plan. */
  readonly plan?: PlanParts;
  /** Whether the agent on an account and model runs Plan's agents (`capabilities.subagents`). */
  readonly subagentsOf: (account: AccountAgent, model: string) => boolean;
  readonly limitsFor: (kind: AccountKind) => PictureLimits;
  /** Who judges a session's calls on an account and model (`capabilities.judge`). */
  readonly judgeOf: (account: AccountAgent, model: string) => JudgeKind;
  /** Whether the agent on an account and model searches the web (`capabilities.webSearch`). */
  readonly webSearchOf: (account: AccountAgent, model: string) => boolean;
  /** 10db's judge, asked whether it is ready as each session starts; absent, a `tendb` chat is on the rules. */
  readonly judge?: Judge;
  readonly clock: Clock;
  /** The project's compose services at its committed base, for a session Docker is open to. */
  readonly composeServices: (
    project: Pick<ProjectDto, 'repoPath' | 'baseBranch'>,
  ) => Promise<ComposeServices | null>;
  /**
   * Reads the project's files as committed at its base and unchanged in `checkout`, for what a shell call runs
   * (`readCommitted`); null shows 10db's judge the call alone.
   */
  readonly readCommitted: (
    project: Pick<ProjectDto, 'repoPath' | 'baseBranch'>,
    checkout: string,
  ) => CommittedReader | null;
  /** Where the chat's tools find the session that calls them. */
  readonly live: ChatLiveSessions;
  /** A reading session's first change: asks the builder where the work happens. */
  readonly firstChange?: (chatId: ChatId) => void;
}

/** A builder message's words for the session: under its id, with each picture not sent as a block named by path. */
function messageText(message: DeliverableMessage, blocks: ReadonlySet<string>): string {
  const paths = message.files
    .filter((f) => !blocks.has(f.id))
    .map((f) => `[picture] ${f.storedPath}`);
  return [`[m:${message.id}] ${message.body}`, ...paths].join('\n');
}

/**
 * The ask of a press that starts a turn, or null when the item is none: a Plan review, Find Open Questions or
 * Design review (each a review turn), or a Figma press (an ask, with no review turn: its `kind` is null).
 */
function reviewOf(
  item: ConversationItemRow,
): { kind: ReviewTurnKind | null; ask: string; inSession: string } | null {
  if (item.kind !== ConversationItemKind.ShapeEvent) return null;
  const body = parseItemBody(item.kind, item.body);
  const kind =
    body.kind === ShapeEventKind.Review
      ? ReviewTurnKind.PlanReview
      : body.kind === ShapeEventKind.Rehearse
        ? ReviewTurnKind.CheckForQuestions
        : body.kind === ShapeEventKind.DesignReview
          ? ReviewTurnKind.DesignReview
          : null;
  const figma =
    body.kind === ShapeEventKind.FigmaOpen || body.kind === ShapeEventKind.FigmaBringBack;
  if ((kind === null && !figma) || body.prompt === undefined) return null;
  return { kind, ask: body.prompt, inSession: body.promptInSession ?? body.prompt };
}

/** A builder's message, or the ask of a review press, which reaches the session as one. */
function deliverable(
  state: StateStore,
  item: ConversationItemRow,
  inSession: boolean,
): DeliverableMessage {
  const review = reviewOf(item);
  const body =
    review !== null
      ? inSession
        ? review.inSession
        : review.ask
      : item.kind === ConversationItemKind.Message
        ? parseItemBody(item.kind, item.body).text
        : '';
  return {
    id: item.id,
    body,
    pushedAt: item.pushedAt,
    pushUuids: item.pushUuids,
    files: listItemFiles(state.db, [item.id]),
  };
}

/** The thread's line for a turn that can only read: who has Your folder. */
function readOnlyNotice(blockers: readonly FolderBlocker[]): string {
  return `Your checkout is in use by ${blockers.map((b) => holderWords(b.holder)).join(' and ')}, so this turn reads only.`;
}

/** A call as the chat's confinement reads it. */
const chatCallOf = (req: Omit<ShapeToolRequest, 'toolUseId'>) => ({
  toolName: req.toolName,
  input: req.input,
  agentId: req.agentId,
  agentType: req.agentType,
  cwd: req.cwd,
});

export function chatHooks(deps: ChatHooksDeps): ExploreOwnerHooks {
  const { state, log } = deps;
  const chatOf = (conv: ConversationRow) => {
    const chat = chatOfConversation(state.db, conv.id);
    if (chat === null) throw new Error(`conversation ${conv.id} is no chat's`);
    return chat;
  };
  /** The plan of a conversation's chat, or null. */
  const planOf = (conv: ConversationRow): ShapeId | null => planOfConversation(state.db, conv.id);
  /** Whether the conversation's agent runs Plan's subagents on the account and model it runs on now. */
  const subagentsKnown = (conv: ConversationRow): boolean => {
    try {
      const launch = deps.launch(conv.projectId, conv.model, conv.effort);
      return deps.subagentsOf(launch.account, launch.modelId);
    } catch {
      // A launch that can't be read reads as the agent form: the session's own start settles the rest.
      return true;
    }
  };
  /** The provider the conversation's agent runs on now; Claude when its launch can't be read. */
  const providerKnown = (conv: ConversationRow): Provider => {
    try {
      return deps.launch(conv.projectId, conv.model, conv.effort).account.harness;
    } catch {
      return Provider.Claude;
    }
  };
  const describe = (conv: ConversationRow, model: string | null) => {
    const launch = deps.launch(conv.projectId, model, conv.effort);
    const name = storedModelNames(state.db).find((m) => m.id === launch.modelId)?.name;
    return {
      model: launch.modelId,
      label: name ?? launch.modelId,
      launchId: launch.model,
      effort: launch.effort,
    };
  };

  // What the thread says once the turn that took the folder has begun, keyed by chat: the take is made before
  // anyone knows a turn will start, so nothing is written until the state says it did.
  const notices = new Map<ChatId, string[]>();
  /** Chats whose turn is under way, so the end of one is told from an idle report of a parked start. */
  const running = new Set<ChatId>();
  // What the chats already in the folder are told once the joining chat's turn has begun.
  const toldOthers = new Map<
    ChatId,
    { readonly conversationId: ConversationId; readonly line: string }[]
  >();
  // The open sessions' ways to stop what their commands left running, keyed by conversation: it stops when
  // a turn ends and the folder goes back, so nothing a warm session started outlives its turn.
  const sessionJobs = new Map<ConversationId, () => Promise<void>>();
  // The session each chat's hold belongs to now: a session that is not it (an older one, closed, whose
  // background agent is still calling) holds nothing even when the chat's next turn holds Your folder.
  const holdingSession = new Map<ChatId, string>();
  // The planning rules a session that started with no plan is owed, keyed by conversation (one session is
  // live per conversation, as `holdingSession`): the next message carries them, or a passing `propose_plan`
  // answers them.
  const owedRules = new Map<
    ConversationId,
    { readonly sessionId: SessionId; peek(): string | null; take(): string | null }
  >();
  // Each conversation's open session: whether it runs no subagents, so does Plan's reviews itself, and the
  // reviews it has been sent that are still live (by the starter's id). A review is live from its send until a
  // turn that took it ends: it was a starter of the turn, or was delivered (an item injected into a running
  // turn is no starter of it, and one handed to the next turn is not delivered yet). A session with no
  // subagents may report a finding only while one is live.
  const reviewing = new Map<
    ConversationId,
    {
      readonly sessionId: SessionId;
      readonly inSession: boolean;
      readonly live: Map<ConversationItemId, { kind: ReviewTurnKind }>;
    }
  >();
  // Each chat's release of Your folder that waits for its jobs to stop. The chat's next turn cancels it: the
  // hold stays with the chat, and what is stopped meanwhile is the turn's before.
  const pendingReleases = new Map<ChatId, { cancelled: boolean }>();
  // How each conversation's open session is closed, for a job that would not stop.
  const sessionClosers = new Map<ConversationId, () => Promise<void>>();
  // How each chat's open session forgets the commands the builder allowed again outside the sandbox: when its
  // turn ends, and when another chat's turn joins it in the checkout.
  const outsideForget = new Map<
    ChatId,
    { readonly sessionId: SessionId; readonly forget: () => void }
  >();
  const say = (conv: ConversationRow, lines: readonly string[]): void => {
    if (lines.length === 0) return;
    state.write((ctx) => {
      for (const text of lines)
        insertItem(ctx, conv.id, {
          author: ConversationItemAuthor.System,
          kind: ConversationItemKind.Notice,
          body: { text },
        });
    });
  };

  /** Whether the chat's turn takes Your folder: Here, or any place while Full access is on. */
  const takesHold = (chat: ChatRow): boolean =>
    chat.workPlace === WorkPlace.Here || (chat.fullAccess && chat.workPlace !== WorkPlace.Moving);

  // Whether the chat's session can write now: Here, while its turn holds the checkout; a branch, in its worktree.
  // A branch with no worktree has nowhere to write, and never falls back to the checkout.
  const writesNow = (chat: ChatRow, repoPath: string): boolean =>
    chatRoot(withWorktreeOnDisk(chat), { repoPath }).writes &&
    (chat.workPlace !== WorkPlace.Here || deps.folderHold.holdsTurn(chat.id));

  return {
    freshAtContextPct: CHAT_FRESH_AT_CONTEXT_PCT,

    turnStarting(conv) {
      const chat = chatOf(conv);
      const waiting = pendingReleases.get(chat.id);
      if (waiting !== undefined) {
        waiting.cancelled = true;
        pendingReleases.delete(chat.id);
      }
      // Only a session working in the builder's checkout takes the hold. One that reads or is being asked holds
      // nothing, and one on its own branch writes its own worktree. A Full access chat has no kernel to keep
      // its shell in its worktree, so it takes the hold wherever it works.
      if (!takesHold(chat)) {
        notices.set(chat.id, []);
        return { writes: writesNow(chat, getProject(state.db, conv.projectId).repoPath) };
      }
      const taken = deps.folderHold.takeTurn(conv.projectId, chat.id);
      if (!taken.taken) {
        if (chat.fullAccess) {
          // No kernel keeps its shell out of the checkout, so it waits for the hold instead of running read-only.
          deps.parkForFolder?.(chat.id);
          return { writes: false };
        }
        notices.set(chat.id, [readOnlyNotice(taken.blockers)]);
        return { writes: false };
      }
      // What the chats already here allowed again outside the sandbox would now run on this chat's changes too.
      for (const h of taken.sharedWith)
        if (h.chatId !== null) outsideForget.get(h.chatId)?.forget();
      const others = taken.sharedWith.map((h) => holderWords(h));
      const joined = holderWords({
        kind: FolderHolderKind.ChatTurn,
        name: chat.title ?? CHAT_DEFAULT_TITLE,
        more: 0,
        chatId: chat.id,
        what: null,
      });
      toldOthers.set(
        chat.id,
        taken.sharedWith.flatMap((h) =>
          h.kind === FolderHolderKind.ChatTurn && h.chatId !== null
            ? [
                {
                  conversationId: getChat(state.db, h.chatId).conversationId,
                  line: `Your checkout is also in use by ${joined}.`,
                },
              ]
            : [],
        ),
      );
      notices.set(
        chat.id,
        others.length === 0 ? [] : [`Your checkout is also in use by ${others.join(' and ')}.`],
      );
      return { writes: true };
    },

    onState(conv, to) {
      const chat = chatOf(conv);
      if (BUSY.has(to)) {
        running.add(chat.id);
        const lines = notices.get(chat.id) ?? [];
        notices.delete(chat.id);
        say(conv, lines);
        for (const other of toldOthers.get(chat.id) ?? [])
          say(getConversation(state.db, other.conversationId), [other.line]);
        toldOthers.delete(chat.id);
        return;
      }
      notices.delete(chat.id);
      toldOthers.delete(chat.id);
      running.delete(chat.id);
      // A release already waits for this chat's jobs: a later change outside a turn (an idle close) joins it, so the
      // chat's next turn has one release to cancel and no earlier one outlives the cancel.
      if (pendingReleases.has(chat.id)) return;
      const endJobs = sessionJobs.get(conv.id);
      if (endJobs === undefined) {
        deps.folderHold.releaseTurn(chat.id);
        return;
      }
      // The folder goes back once nothing the turn left running can write to it.
      const release = { cancelled: false };
      pendingReleases.set(chat.id, release);
      void (async () => {
        try {
          await withDeadline(endJobs(), deps.clock, JOBS_STOP_DEADLINE_MS);
        } catch (error) {
          log.warn(
            { err: error, conversationId: conv.id },
            'a chat’s jobs could not be stopped, so its session is closed',
          );
          // A job that could not be stopped runs inside this session's sandbox: closing it ends them. A next turn
          // that already began is using the session, so it is left to that turn's own end.
          if (!release.cancelled) await sessionClosers.get(conv.id)?.();
        }
        if (release.cancelled) return;
        if (pendingReleases.get(chat.id) === release) pendingReleases.delete(chat.id);
        deps.folderHold.releaseTurn(chat.id);
      })();
    },

    limits(conv) {
      return deps.limitsFor(deps.launch(conv.projectId, conv.model, conv.effort).account.kind);
    },

    async spec(conv, start) {
      const chat = chatOf(conv);
      const launch = deps.launch(conv.projectId, conv.model, conv.effort);
      const limits = deps.limitsFor(launch.account.kind);
      // A chat asks for its agent's judge, as Plan does; 10db's judge where it is the account's and ready.
      const tendbReady = (await deps.judge?.ready(JudgeDecision.CrossesLimit)) ?? false;
      const judge = startingJudge(deps.judgeOf(launch.account, launch.modelId), true, tendbReady);
      const project = getProject(state.db, conv.projectId);
      const { root } = chatRoot(withWorktreeOnDisk(chat), { repoPath: launch.cwd });
      // Full access runs on a Claude account as Claude Code does in a terminal (a Codex chat's side is its own).
      const fullInputs =
        chat.fullAccess && launch.account.harness === Provider.Claude
          ? (launch.fullAccess?.() ?? FULL_ACCESS_DEFAULTS)
          : null;
      const full: FullAccessSettings | null =
        fullInputs === null
          ? null
          : fullAccessSettings({
              kind: launch.account.kind,
              autoModeRuns: deps.judgeOf(launch.account, launch.modelId) === JudgeKind.Native,
              apiKeyHelper: fullInputs.apiKeyHelper,
              defaultConfigDir: fullInputs.defaultConfigDir,
              keyInEnv: fullInputs.keyInEnv,
            });
      // A Codex chat runs Codex's own full-access mode, still under 10db's guard hook and judge.
      const fullCodex = chat.fullAccess && launch.account.harness === Provider.Codex;
      const fullAgent = full !== null ? 'claude' : fullCodex ? 'codex' : null;
      // Codex's judge is 10db's alone, so a Full access turn it can't judge never starts: the builder reads why
      // in the thread and turns Full access off to go on in the sandbox.
      if (fullCodex && (deps.judge === undefined || judge === JudgeKind.Rules))
        throw new InvalidError(
          `Full access on Codex needs 10db’s judge, and it is off: ${floorWhy(FloorReason.NoJudge)} Turn Full access off to continue in the sandbox.`,
        );
      // A Full access session can write wherever its turn holds the folder, which every one of its turns does.
      const writable = full !== null || fullCodex || writesNow(chat, launch.cwd);
      const folder: ChatPlace = {
        get place() {
          return getChat(state.db, chat.id).workPlace;
        },
        holds: () => {
          const place = getChat(state.db, chat.id).workPlace;
          const current = holdingSession.get(chat.id) === start.sessionId;
          if (full !== null || fullCodex) return current && deps.folderHold.holdsTurn(chat.id);
          if (place === WorkPlace.Here) return current && deps.folderHold.holdsTurn(chat.id);
          if (place === WorkPlace.Branch)
            return (
              current &&
              running.has(chat.id) &&
              withWorktreeOnDisk(getChat(state.db, chat.id)).worktreePath !== null
            );
          return false;
        },
        current: () => holdingSession.get(chat.id) === start.sessionId,
        writable,
        heldBy: () =>
          deps.folderHold
            .blockers(conv.projectId, { kind: FolderAsker.ChatTurn, chatId: chat.id })
            .map((b) => holderWords(b.holder))
            .join(' and ') || 'something else',
        root,
        checkout: launch.cwd,
        firstChange: () => deps.firstChange?.(chat.id),
      };
      // A Claude chat's sandbox lets one command ask to run outside it, each judged by the hook and then the
      // builder; Full access has no sandbox, and Codex runs with approvals off.
      const codexChat = launch.account.harness === Provider.Codex;
      // How many calls that could change something this session has let through, moved too when its turn ends
      // and when another chat joins the checkout: a command the builder allowed to run again outside the
      // sandbox lasts only until this moves, or a background task runs.
      let changes = 0;
      let backgrounded = false;
      const asksOutside = full === null && !fullCodex && launch.account.harness === Provider.Claude;
      if (asksOutside)
        outsideForget.set(chat.id, {
          sessionId: start.sessionId,
          forget: () => {
            changes += 1;
          },
        });
      const shapeId = planOfConversation(state.db, conv.id);
      const plan = deps.plan;
      // Every chat has its plan's folder, derived from the chat until a plan exists. Made before the sandbox,
      // which opens it only when it exists, and fixed for the session: Codex's kernel grant is set at start and
      // Claude's guard reads `access`, so a file dropped once a plan begins mid-session lands inside it.
      const planFiles = plan?.filesDir(shapeId ?? planIdOfChat(chat.id));
      const limitNotes = createLimitNotes();
      const ending = new AbortController();
      const prepareInput: ShapePrepareInput = {
        projectId: conv.projectId,
        conversationId: conv.id,
        sessionId: start.sessionId,
        harness: launch.account.harness,
        env: launch.env,
        resumeProviderSessionId: start.resume,
        writes: writable,
        ...(planFiles === undefined ? {} : { planFiles }),
        ...(root === launch.cwd ? {} : { checkout: root }),
        signal: ending.signal,
        observer: start.observer,
        limits: limitNotes,
        chat: true,
        ...(asksOutside
          ? {
              unsandboxedAsk: {
                mayRun: () => outsideSandboxRefusal(folder),
                changes: () => changes,
                bump: () => {
                  changes += 1;
                },
                background: () => runningNow(),
                // A checkout shared with anything else can change between two reads of it, unseen by this session.
                remembers: () =>
                  !backgrounded &&
                  !deps.folderHold
                    .holders(conv.projectId, chat.id)
                    .some((h) => h.kind !== FolderHolderKind.WaitingChat),
                checkoutState: () =>
                  deps.checkoutState(launch.cwd).catch((err: unknown) => {
                    log.warn(
                      { err, conversationId: conv.id },
                      'the checkout could not be read for a remembered command',
                    );
                    return null;
                  }),
              },
            }
          : {}),
      };
      let ready: ShapePrepared | null;
      if (full !== null || fullCodex)
        // Where Claude Code finds the builder's own setup (their default config folder) nothing is relayed;
        // Codex's home is 10db's own, so its instructions and servers always are.
        ready =
          (await deps.prepareFullAccess?.({
            ...prepareInput,
            relay: !full?.ownSetup,
          })) ?? null;
      else ready = deps.prepare === undefined ? null : await deps.prepare(prepareInput);
      // A session that starts with no plan is owed the planning rules once it has one. A session that has its
      // plan at start, resumed or not, holds the rules in its system prompt (a resumed Codex thread's
      // developer instructions are configuration overrides for it), so it is owed nothing.
      const owesRules = shapeId === null;
      let owed: string | null = null;
      const planRules =
        owesRules && plan !== undefined
          ? {
              peek: () => owed,
              take: () => {
                const rules = owed;
                owed = null;
                return rules;
              },
            }
          : null;
      const liveReviews = new Map<ConversationItemId, { kind: ReviewTurnKind }>();
      const reviewTurns = (): readonly ShapeReviewTurn[] =>
        [...liveReviews].map(([id, r]) => ({ id, kind: r.kind }));
      let noSubagents = false;
      let opened: SessionHandle | null = null;
      deps.live.open(conv.id, {
        sessionId: start.sessionId,
        observer: start.observer,
        signal: ending.signal,
        planRules,
        review: reviewTurns,
        inSession: () => noSubagents,
        // Codex's code mode answers a script text only, so the pictures a tool returned reach its model as a
        // message steered into the turn, under 10db's own caption and never the tool's text.
        ...(launch.account.harness === Provider.Codex
          ? {
              showImages: (shown: ToolImages) => {
                if (shown.images.length > 0)
                  opened?.send(TOOL_PICTURES_CAPTION, shown.images, undefined, { steerOnly: true });
              },
            }
          : {}),
      });
      holdingSession.set(chat.id, start.sessionId);
      // A read that fails counts as still running: the deadline then closes the session and gives the folder back.
      const runningNow = (): boolean => {
        try {
          return deps.backgroundRunning?.(conv.id) === true;
        } catch (error) {
          log.warn({ err: error, conversationId: conv.id }, 'background tasks could not be read');
          return true;
        }
      };
      // A Full access turn's folder goes back once the SDK reports no background task running.
      const backgroundGone = (): Promise<void> =>
        new Promise<void>((resolve) => {
          const look = (): void => {
            if (ending.signal.aborted || !runningNow()) resolve();
            else deps.clock.setTimeout(look, BACKGROUND_POLL_MS);
          };
          look();
        });
      const endJobs =
        full !== null || fullCodex
          ? backgroundGone
          : ready === null
            ? undefined
            : () => ready.endJobs();
      if (endJobs !== undefined) sessionJobs.set(conv.id, endJobs);
      let marked = false;
      let released: Promise<void> | null = null;
      const release = (): Promise<void> => {
        released ??= (async () => {
          ending.abort();
          if (sessionJobs.get(conv.id) === endJobs) sessionJobs.delete(conv.id);
          if (sessionClosers.get(conv.id) === closer) sessionClosers.delete(conv.id);
          if (holdingSession.get(chat.id) === start.sessionId) holdingSession.delete(chat.id);
          if (outsideForget.get(chat.id)?.sessionId === start.sessionId)
            outsideForget.delete(chat.id);
          if (owedRules.get(conv.id)?.sessionId === start.sessionId) owedRules.delete(conv.id);
          if (reviewing.get(conv.id)?.sessionId === start.sessionId) reviewing.delete(conv.id);
          deps.live.end(conv.id, start.sessionId);
          try {
            await ready?.release();
          } catch (error) {
            log.warn(
              { err: error, conversationId: conv.id },
              'a chat session’s sandbox could not be removed',
            );
          }
        })();
        return released;
      };
      // A Full access session's commands run outside any sandbox, so closing it is what stops them.
      const closer = async (): Promise<void> => {
        if (full !== null || fullCodex) await opened?.stop();
        await release();
      };
      sessionClosers.set(conv.id, closer);
      const setup = ready?.setup ?? null;
      // A branch session reads and runs in its own worktree, so that is the checkout its reads are judged against.
      const access: ShapeAccess = {
        ...launch.access,
        checkout: root,
        filesDir: chatFolder(deps.dataDir, conv.id),
        ...(planFiles === undefined ? {} : { planFilesDir: planFiles }),
        agentModels: launch.agentModels,
        judge,
        ...(asksOutside ? { unsandboxed: 'ask' as const } : {}),
        ...(setup === null || setup.reads.length === 0
          ? {}
          : {
              setupReads: setup.reads,
              secretFiles: [...(launch.access.secretFiles ?? []), ...setup.secretFiles],
            }),
        ...(ready?.commands === undefined ? {} : { commands: ready.commands }),
      };
      const switches = trustSwitchesFor(state.db, project.id, warnInvalidTrust(log));
      const claudeConnectors =
        (ready?.claudeConnectors ?? false) &&
        launch.account.kind === AccountKind.ClaudeSubscription;
      // As the session's sandbox is built: Docker for a session that writes, loopback by the project's switch.
      // A Full access Codex session has no sandbox, so Docker and loopback are open to it, as they are to its shell.
      const open = fullCodex
        ? { docker: true, localhost: true }
        : sessionDevAccess(project, {
            sandboxed: (ready?.sandbox ?? null) !== null,
            writes: writable,
          });
      const policyOf = (compose: ComposeServices | null): TrustPolicy =>
        buildTrustPolicy({
          surface: TrustSurface.Chat,
          projectName: project.name,
          checkout: root,
          gateCommand: project.gateCommand,
          liveSystems: projectLiveSystems(state.db, project.id, (stored) => {
            log.warn(
              { stored },
              'the stored live systems are not a list 10db reads, so it reads none',
            );
          }),
          switches,
          grants: projectGrantLines(state.db, project.id),
          yourMcpServers: Object.keys(ready?.yourMcpServers ?? {}),
          claudeConnectors,
          devAccess: { ...open, compose: open.docker ? compose : null },
          builderFolder: project.repoPath,
        });
      // A Claude Full access session is judged by Claude Code, which reads no policy: it is built only if read.
      const policy =
        full === null ? policyOf(open.docker ? await deps.composeServices(project) : null) : null;
      // The thread says once per session that 10db's judge stopped answering.
      let saidUnavailable = false;
      const webOn =
        deps.webSearchOf(launch.account, launch.modelId) &&
        (launch.account.harness === Provider.Claude || switches.web);
      const subagents = deps.subagentsOf(launch.account, launch.modelId);
      noSubagents = !subagents;
      reviewing.set(conv.id, {
        sessionId: start.sessionId,
        inSession: noSubagents,
        live: liveReviews,
      });
      // The web the session has: the chat's confinement refuses Claude's web tools on any judge but auto
      // mode's, while Codex's own search needs no tool call and runs under the Web switch.
      const web =
        webOn && (judge === JudgeKind.Native || launch.account.harness === Provider.Codex);
      // A plan can begin while the session runs, so its read budget is resolved at each call, once per plan.
      const readsOf = new Map<ShapeId, ReturnType<PlanParts['reads']>>();
      const readsNow = (): ReturnType<PlanParts['reads']> | undefined => {
        const id = planOf(conv);
        if (id === null || plan === undefined) return undefined;
        let reads = readsOf.get(id);
        if (reads === undefined) {
          reads = plan.reads(id, access, limits);
          readsOf.set(id, reads);
        }
        return reads;
      };
      if (plan !== undefined && planRules !== null) {
        owed = owedPlanningRules(plan.systemPrompt(launch.agentModels, subagents, web));
        owedRules.set(conv.id, { sessionId: start.sessionId, ...planRules });
      }
      // A session with nothing to resume is told the standing rules, and what it missed as a digest.
      const where =
        chat.workPlace === WorkPlace.Branch
          ? workNote(chat, launch.cwd, deps.firstStartAfterMove?.delete(chat.id) ?? false)
          : null;
      const parts = [
        ...(where === null ? [] : [where]),
        ...(ready?.note === null || ready?.note === undefined ? [] : [ready.note]),
        ...(start.resume === null ? [principlesBrief(state.db, conv.projectId)] : []),
        ...(start.digest === null ? [] : [start.digest]),
        ...(plan === undefined || shapeId === null ? [] : plan.opening(shapeId, conv, start)),
        start.first.text,
      ].filter((part) => part !== '');
      return {
        spec: {
          sessionId: start.sessionId,
          conversationId: conv.id,
          get policy() {
            return policy ?? policyOf(null);
          },
          profile: {
            kind: 'explore',
            judge,
            systemPrompt:
              plan === undefined
                ? chatSystemPrompt(webOn, fullAgent, codexChat)
                : `${chatSystemPrompt(webOn, fullAgent, codexChat)}\n\n${
                    shapeId === null
                      ? PLANNING_STUB
                      : plan.systemPrompt(launch.agentModels, subagents, web)
                  }`,
            ...chatProfile(full !== null || fullCodex || ready?.commands !== undefined),
            ...(plan === undefined
              ? {}
              : {
                  agents: plan.agents(
                    full !== null || fullCodex || ready?.commands !== undefined,
                    subagents,
                    web,
                  ),
                }),
          },
          cwd: root,
          instructions: ready?.instructions ?? null,
          ...(setup === null
            ? {}
            : { setup: { plugins: setup.pluginDirs, skillRoots: setup.skillRoots } }),
          prompt: parts.join('\n\n'),
          ...(start.first.images.length === 0 ? {} : { images: start.first.images }),
          model: launch.model,
          effort: launch.effort,
          resumeProviderSessionId: start.resume,
          env: launch.env,
          account: launch.account,
          // Codex's web search, under the Web switch as a lane's is; Claude's web is its hook's.
          webSearch: switches.web ? 'live' : 'disabled',
          // A tool that asks waits on the builder as long as a lane's question does.
          mcp: {
            url: deps.mcp.url,
            token: start.mcpToken,
            toolTimeoutMs: (project.humanWaitMinutes + 5) * 60_000,
          },
          hookWaitMs: (project.humanWaitMinutes + 5) * 60_000,
          ...(full === null ? {} : { fullAccess: full }),
          ...(fullCodex ? { fullAccess: CODEX_FULL_ACCESS } : {}),
          sandbox: ready?.sandbox ?? null,
          projectMcpServers: ready?.projectMcpServers ?? {},
          yourMcpServers: ready?.yourMcpServers ?? {},
          claudeConnectors,
          canUseTool: (req) =>
            ready === null
              ? Promise.resolve({ behavior: 'deny', message: NOTHING_TO_ASK, by: DeniedBy.TenDb })
              : ready.canUseTool(req),
          // Each call by its own judge: a native session's call outside auto mode has no classifier behind it.
          preToolUse: (req) => {
            if (full !== null || fullCodex) {
              const verdict = judgeFullAccessCall(chatCallOf(req), root, folder, reviewTurns);
              return readsNow()?.preToolUse(req, verdict) ?? verdict;
            }
            // The first command marks what the session runs, so the jobs its commands start can be told apart.
            if (req.toolName === 'Bash' && !marked) {
              marked = true;
              ready?.markOwn();
            }
            const verdict = judgeChatCall(
              chatCallOf(req),
              {
                ...access,
                judge: judgeForCall(judge, req.reportedMode ?? null, tendbReady),
              },
              folder,
              reviewTurns,
            );
            const settled = readsNow()?.preToolUse(req, verdict) ?? verdict;
            if (settled.decision !== 'deny') {
              if (couldChange(chatCallOf(req))) changes += 1;
              // From a background start on, the session can change things unseen: nothing is remembered.
              if (startsBackground(chatCallOf(req))) backgrounded = true;
            }
            return settled;
          },
          ...(plan === undefined
            ? {}
            : {
                postToolUse: (req) => {
                  readsNow()?.postToolUse(req);
                },
                toolFailed: (req) => {
                  readsNow()?.toolFailed(req);
                },
              }),
          ...(full !== null || deps.judge === undefined || judge === JudgeKind.Rules
            ? {}
            : {
                judgeCall: createHookJudge(
                  { judge: deps.judge, state, logger: log },
                  {
                    projectId: project.id,
                    workstreamId: null,
                    taskId: null,
                    // The fast path's write rule is a lane's; a chat's edits are judged by `folder` above it.
                    fastPath: {
                      checkout: root,
                      tmpDir: root,
                      secretFiles: access.secretFiles ?? [],
                      preExisting: [],
                      setupReads: access.setupReads ?? [],
                    },
                    policy: policy ?? policyOf(null),
                    allowLines: () => projectGrantLines(state.db, project.id),
                    // A chat is no run, so it has no Retry or Send back notes.
                    builderNotes: [],
                    judgeNow: (req) => judgeForCall(judge, req.reportedMode ?? null, tendbReady),
                    // A chat's allow list holds none of the project's allowed commands.
                    coveredByBuilderRule: () => false,
                    floorVerdict: (req) => {
                      const floor = judgeChatCall(
                        chatCallOf(req),
                        { ...access, judge: JudgeKind.Rules },
                        folder,
                        reviewTurns,
                      );
                      // A rewrite of the call is the guard's; its decision is what the floor gives.
                      return 'updatedInput' in floor ? { decision: 'allow' } : floor;
                    },
                    readCommitted: deps.readCommitted(project, root),
                    skips: null,
                    limits: limitNotes,
                    onFloor: (detail) => {
                      if (saidUnavailable) return;
                      saidUnavailable = true;
                      state.write((ctx) => {
                        insertItem(ctx, conv.id, {
                          author: ConversationItemAuthor.System,
                          kind: ConversationItemKind.Notice,
                          body: {
                            text: floorNoticeText(FloorReason.JudgeUnavailable, {
                              attended: true,
                              detail,
                            }),
                          },
                        });
                      });
                    },
                    clock: deps.clock,
                  },
                ),
              }),
        },
        limits,
        writes: writable,
        expiresAt: ready?.credentialsExpireAt ?? null,
        accountId: launch.account.accountId,
        model: launch.modelId,
        release,
        track: (pid) => {
          ready?.trackProcesses(pid);
        },
        opened: (handle) => {
          opened = handle;
        },
      };
    },

    digest(conv) {
      const shapeId = planOf(conv);
      const chat = chatDigest(state, conv.id);
      if (shapeId === null || deps.plan === undefined) return chat;
      return [chat, deps.plan.digest(shapeId)].filter((part) => part !== '').join('\n\n');
    },

    keepsResume(conv) {
      const shapeId = planOf(conv);
      if (shapeId === null || deps.plan === undefined) return true;
      // A launch that can't be resolved resumes: the start that follows fails with the reason.
      let launch: ShapeLaunch;
      try {
        launch = deps.launch(conv.projectId, conv.model, conv.effort);
      } catch (error) {
        if (error instanceof InvalidError) return true;
        throw error;
      }
      return deps.plan.keepsResume(
        shapeId,
        deps.limitsFor(launch.account.kind),
        launch.account.label,
      );
    },

    onParked(conv) {
      const shapeId = planOf(conv);
      if (shapeId !== null) deps.plan?.announce(shapeId);
    },

    outgoing(conv, item, session) {
      const shapeId = planOf(conv);
      // A plan's session counts its screens and Reads too: one budget for everything it carries.
      const spent = session.fresh
        ? 0
        : shapeId !== null && deps.plan !== undefined
          ? deps.plan.inlineSpent(shapeId, session.limits)
          : heldInlineBytes(listFiles(state.db, conv.id), session.limits);
      const review = reviewOf(item);
      const inSession = reviewing.get(conv.id)?.inSession ?? !subagentsKnown(conv);
      const out = outgoingMessage(
        deliverable(state, item, inSession),
        spent,
        session.limits,
        false,
        messageText,
        randomUUID,
      );
      if (shapeId === null || deps.plan === undefined)
        return { text: out.text, images: out.images, blocks: out.blocks, sent: () => undefined };
      // A review the session does itself is its review turn from the send until the turn ends.
      const startReview = (): void => {
        const open = reviewing.get(conv.id);
        const reviewKind = review?.kind ?? null;
        if (reviewKind !== null && open?.inSession === true)
          open.live.set(item.id, { kind: reviewKind });
      };
      // The plan's lines go ahead of the message, and its pictures join the message's under the one budget.
      const sentAsBlocks = new Set<string>(out.blocks);
      const carrying = listFiles(state.db, conv.id)
        .filter((file) => sentAsBlocks.has(file.id))
        .reduce((sum, file) => sum + file.size, 0);
      const intake = deps.plan.intake(shapeId, conv, item, {
        fresh: session.fresh,
        digest: session.digest,
        limits: session.limits,
        provider: providerKnown(conv),
        carrying,
      });
      // A session that started before its plan is owed the planning rules: they go first, and are owed no
      // longer once the send has happened, so a send that throws leaves them for the next message.
      const owing = owedRules.get(conv.id);
      const rules = owing?.peek() ?? null;
      const lines = [
        ...(rules === null ? [] : [rules]),
        ...(intake.lines === '' ? [] : [intake.lines]),
      ];
      return {
        text: lines.length === 0 ? out.text : `${lines.join('\n\n')}\n\n${out.text}`,
        images: [...out.images, ...intake.images],
        blocks: [...out.blocks, ...intake.blocks],
        sent: (ctx) => {
          intake.sent(ctx);
          owing?.take();
          startReview();
        },
      };
    },

    onTurnEnded(conv, end) {
      const open = reviewing.get(conv.id);
      if (open !== undefined) {
        const kept = reviewsAfterTurnEnd(
          [...open.live].map(([id, r]) => ({ id, kind: r.kind })),
          end.starters,
          (id) => getItem(state.db, id).deliveredAt !== null,
        );
        for (const id of [...open.live.keys()])
          if (!kept.some((r) => r.id === id)) open.live.delete(id);
      }
      const chat = chatOf(conv);
      // The builder's yes to run a command again outside the sandbox lasts for the turn it was given in.
      outsideForget.get(chat.id)?.forget();
      state.write((ctx) => {
        touchChat(ctx, chat.id, deps.now().toISOString());
      });
      const shapeId = planOf(conv);
      if (shapeId !== null) deps.plan?.onTurnEnded(shapeId, end);
      return Promise.resolve();
    },

    describeModel: describe,
  };
}

/** What a fresh session is told of the chat so far: the builder's messages and the agent's replies. */
export function chatDigest(state: StateStore, conversationId: ConversationId): string {
  const text = digestText(listItems(state.db, conversationId, {}));
  if (text === '') return '';
  return `This chat continues in a fresh session. What was said so far:\n\n${text}`;
}
