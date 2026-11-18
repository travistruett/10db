import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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
  parseItemBody,
  Provider,
  providerOf,
  TrustSurface,
  AccountKind,
  type Effort,
  type AgentAccountKind,
  type ProjectId,
  type ChatId,
  WorkPlace,
} from '@10db/contracts';
import {
  chatOfConversation,
  getChat,
  getConversation,
  getProject,
  insertItem,
  listFiles,
  listItemFiles,
  listItems,
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
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import { holderWords, type FolderBlocker, type FolderHold } from '../folder-hold';
import { createHookJudge, createLimitNotes } from '../inbox';
import type { Judge } from '../judge';
import { principlesBrief } from '../knowledge';
import type { Logger } from '../log';
import { trustSwitchesFor, warnInvalidTrust } from '../permissions';
import type { ExploreProfile, ShapeToolRequest } from '../sessions';
import type { ShapeAccess, ShapeLaunch, ShapePrepared, ShapePrepareInput } from '../shape';
import {
  buildTrustPolicy,
  FloorReason,
  floorNoticeText,
  judgeForCall,
  projectGrantLines,
  projectLiveSystems,
  startingJudge,
} from '../trust';
import { digestText } from './brief';
import { judgeChatCall, type ChatPlace } from './confinement';
import { workNote } from './work-note';
import { chatRoot } from './work-root';
import { JUDGED_CHAT_TOOLS } from './git-rule';
import type { ChatLiveSessions } from './live-sessions';
import { chatSystemPrompt } from './prompt';

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
  readonly limitsFor: (kind: AccountKind) => PictureLimits;
  /** Who judges a session's calls on an account kind and model (`capabilities.judge`). */
  readonly judgeOf: (kind: AgentAccountKind, model: string) => JudgeKind;
  /** Whether the agent on an account kind and model searches the web (`capabilities.webSearch`). */
  readonly webSearchOf: (kind: AgentAccountKind, model: string) => boolean;
  /** 10db's judge, asked whether it is ready as each session starts; absent, a `tendb` chat is on the rules. */
  readonly judge?: Judge;
  readonly clock: Clock;
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

function deliverable(state: StateStore, item: ConversationItemRow): DeliverableMessage {
  const body =
    item.kind === ConversationItemKind.Message ? parseItemBody(item.kind, item.body).text : '';
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
  // Each chat's release of Your folder that waits for its jobs to stop. The chat's next turn cancels it: the
  // hold stays with the chat, and what is stopped meanwhile is the turn's before.
  const pendingReleases = new Map<ChatId, { cancelled: boolean }>();
  // How each conversation's open session is closed, for a job that would not stop.
  const sessionClosers = new Map<ConversationId, () => Promise<void>>();
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

  // Whether the chat's session can write now: Here, while its turn holds the checkout; a branch, in its worktree.
  // A branch with no worktree has nowhere to write, and never falls back to the checkout.
  const writesNow = (chat: ChatRow, repoPath: string): boolean =>
    chatRoot(chat, { repoPath }).writes &&
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
      // nothing, and one on its own branch writes its own worktree.
      if (chat.workPlace !== WorkPlace.Here) {
        notices.set(chat.id, []);
        return { writes: writesNow(chat, getProject(state.db, conv.projectId).repoPath) };
      }
      const taken = deps.folderHold.takeTurn(conv.projectId, chat.id);
      if (!taken.taken) {
        notices.set(chat.id, [readOnlyNotice(taken.blockers)]);
        return { writes: false };
      }
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
      const judge = startingJudge(
        deps.judgeOf(launch.account.kind, launch.modelId),
        true,
        tendbReady,
      );
      const project = getProject(state.db, conv.projectId);
      const { root } = chatRoot(chat, { repoPath: launch.cwd });
      const writable = writesNow(chat, launch.cwd);
      const folder: ChatPlace = {
        get place() {
          return getChat(state.db, chat.id).workPlace;
        },
        holds: () => {
          const place = getChat(state.db, chat.id).workPlace;
          const current = holdingSession.get(chat.id) === start.sessionId;
          if (place === WorkPlace.Here) return current && deps.folderHold.holdsTurn(chat.id);
          if (place === WorkPlace.Branch)
            return (
              current && running.has(chat.id) && getChat(state.db, chat.id).worktreePath !== null
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
      const limitNotes = createLimitNotes();
      const ending = new AbortController();
      const ready =
        deps.prepare === undefined
          ? null
          : await deps.prepare({
              projectId: conv.projectId,
              conversationId: conv.id,
              sessionId: start.sessionId,
              accountKind: launch.account.kind,
              env: launch.env,
              resumeProviderSessionId: start.resume,
              writes: writable,
              ...(root === launch.cwd ? {} : { checkout: root }),
              signal: ending.signal,
              observer: start.observer,
              limits: limitNotes,
            });
      deps.live.open(conv.id, {
        sessionId: start.sessionId,
        observer: start.observer,
        signal: ending.signal,
      });
      holdingSession.set(chat.id, start.sessionId);
      const endJobs = ready === null ? undefined : () => ready.endJobs();
      if (endJobs !== undefined) sessionJobs.set(conv.id, endJobs);
      let marked = false;
      let released: Promise<void> | null = null;
      const release = (): Promise<void> => {
        released ??= (async () => {
          ending.abort();
          if (sessionJobs.get(conv.id) === endJobs) sessionJobs.delete(conv.id);
          if (sessionClosers.get(conv.id) === release) sessionClosers.delete(conv.id);
          if (holdingSession.get(chat.id) === start.sessionId) holdingSession.delete(chat.id);
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
      sessionClosers.set(conv.id, release);
      const setup = ready?.setup ?? null;
      const access: ShapeAccess = {
        ...launch.access,
        filesDir: chatFolder(deps.dataDir, conv.id),
        agentModels: launch.agentModels,
        judge,
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
      const policy = buildTrustPolicy({
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
      });
      // The thread says once per session that 10db's judge stopped answering.
      let saidUnavailable = false;
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
        start.first.text,
      ].filter((part) => part !== '');
      return {
        spec: {
          sessionId: start.sessionId,
          conversationId: conv.id,
          policy,
          profile: {
            kind: 'explore',
            judge,
            systemPrompt: chatSystemPrompt(
              deps.webSearchOf(launch.account.kind, launch.modelId) &&
                (providerOf(launch.account.kind) === Provider.Claude || switches.web),
            ),
            ...chatProfile(ready?.commands !== undefined),
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
            // The first command marks what the session runs, so the jobs its commands start can be told apart.
            if (req.toolName === 'Bash' && !marked) {
              marked = true;
              ready?.markOwn();
            }
            return judgeChatCall(
              chatCallOf(req),
              {
                ...access,
                judge: judgeForCall(judge, req.reportedMode ?? null, tendbReady),
              },
              folder,
            );
          },
          ...(deps.judge === undefined || judge === JudgeKind.Rules
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
                    },
                    policy,
                    allowLines: () => projectGrantLines(state.db, project.id),
                    judgeNow: (req) => judgeForCall(judge, req.reportedMode ?? null, tendbReady),
                    // A chat's allow list holds none of the project's allowed commands.
                    coveredByBuilderRule: () => false,
                    floorVerdict: (req) => {
                      const floor = judgeChatCall(
                        chatCallOf(req),
                        { ...access, judge: JudgeKind.Rules },
                        folder,
                      );
                      // A rewrite of the call is the guard's; its decision is what the floor gives.
                      return 'updatedInput' in floor ? { decision: 'allow' } : floor;
                    },
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
      };
    },

    digest(conv) {
      return chatDigest(state, conv.id);
    },

    outgoing(conv, item, session) {
      const spent = session.fresh
        ? 0
        : heldInlineBytes(listFiles(state.db, conv.id), session.limits);
      const out = outgoingMessage(
        deliverable(state, item),
        spent,
        session.limits,
        false,
        messageText,
        randomUUID,
      );
      return { text: out.text, images: out.images, blocks: out.blocks, sent: () => undefined };
    },

    onTurnEnded(conv) {
      const chat = chatOf(conv);
      state.write((ctx) => {
        touchChat(ctx, chat.id, deps.now().toISOString());
      });
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
