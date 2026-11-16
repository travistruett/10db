import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  ChatToolName,
  JudgeDecision,
  JudgeKind,
  ConversationId,
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
} from '@10db/contracts';
import {
  chatOfConversation,
  getProject,
  insertItem,
  listFiles,
  listItemFiles,
  listItems,
  touchChat,
  type ConversationItemRow,
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
import { judgeChatCall } from './confinement';
import type { ChatLiveSessions } from './live-sessions';
import { chatSystemPrompt } from './prompt';

// Sessions spec §7.1, trust line §5: a chat as an owner of the explore engine. Its session is the
// explore profile as the attended one: Plan's read-only sandbox and read tools, commands judged, the
// web where a judge sees each call, Claude Code's own subagents, the builder's setup, and 10db's own
// server with every builder tool. It writes nothing in the checkout until M6.

/** The share of the context window past which a chat moves to a fresh session. */
export const CHAT_FRESH_AT_CONTEXT_PCT = 70;

/** What a chat's session that has no sandbox answers a call it would have asked about. */
const NOTHING_TO_ASK = 'This chat has no sandbox, so it runs no command and asks for nothing.';

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Skill'] as const;
const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;
const AGENT_TOOLS = ['Task', 'Agent'] as const;
/** Named so that a built-in that writes, or watches without end, never reaches a chat. */
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Monitor'] as const;

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
    tools: [...READ_TOOLS, ...WEB_TOOLS, ...AGENT_TOOLS, ...(sandboxed ? ['Bash'] : [])],
    allowedTools: ['Read', 'Grep', 'Glob', 'Skill', ...CHAT_MCP_TOOLS],
    disallowedTools: [...WRITE_TOOLS, ...(sandboxed ? [] : ['Bash'])],
    agents: {},
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
  return `Your folder is in use by ${blockers.map((b) => holderWords(b.holder)).join(' and ')}, so this turn reads only.`;
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

  return {
    freshAtContextPct: CHAT_FRESH_AT_CONTEXT_PCT,

    turnStarting(conv) {
      const chat = chatOf(conv);
      const taken = deps.folderHold.takeTurn(conv.projectId, chat.id);
      if (!taken.taken) {
        notices.set(chat.id, [readOnlyNotice(taken.blockers)]);
        return { writes: false };
      }
      const others = taken.sharedWith.map((h) => holderWords(h));
      notices.set(
        chat.id,
        others.length === 0 ? [] : [`Your folder is also in use by ${others.join(' and ')}.`],
      );
      return { writes: true };
    },

    onState(conv, to) {
      const chat = chatOf(conv);
      if (BUSY.has(to)) {
        const lines = notices.get(chat.id) ?? [];
        notices.delete(chat.id);
        say(conv, lines);
        return;
      }
      notices.delete(chat.id);
      deps.folderHold.releaseTurn(chat.id);
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
      const limitNotes = createLimitNotes();
      const project = getProject(state.db, conv.projectId);
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
              signal: ending.signal,
              observer: start.observer,
              limits: limitNotes,
            });
      deps.live.open(conv.id, {
        sessionId: start.sessionId,
        observer: start.observer,
        signal: ending.signal,
      });
      let released: Promise<void> | null = null;
      const release = (): Promise<void> => {
        released ??= (async () => {
          ending.abort();
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
        checkout: launch.cwd,
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
      const parts = [
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
          cwd: launch.cwd,
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
          preToolUse: (req) =>
            judgeChatCall(chatCallOf(req), {
              ...access,
              judge: judgeForCall(judge, req.reportedMode ?? null, tendbReady),
            }),
          ...(deps.judge === undefined || judge === JudgeKind.Rules
            ? {}
            : {
                judgeCall: createHookJudge(
                  { judge: deps.judge, state, logger: log },
                  {
                    projectId: project.id,
                    workstreamId: null,
                    taskId: null,
                    // A chat writes nothing, so its edits never reach the fast path's write rule.
                    fastPath: {
                      checkout: launch.cwd,
                      tmpDir: launch.cwd,
                      secretFiles: access.secretFiles ?? [],
                      preExisting: [],
                    },
                    policy,
                    allowLines: () => projectGrantLines(state.db, project.id),
                    judgeNow: (req) => judgeForCall(judge, req.reportedMode ?? null, tendbReady),
                    // A chat's allow list holds none of the project's allowed commands.
                    coveredByBuilderRule: () => false,
                    floorVerdict: (req) => {
                      const floor = judgeChatCall(chatCallOf(req), {
                        ...access,
                        judge: JudgeKind.Rules,
                      });
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
        writes: deps.folderHold.holdsTurn(chat.id),
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

/** The most characters of the conversation a fresh session is told, newest kept. */
const DIGEST_MAX_CHARS = 12_000;

/** What a fresh session is told of the chat so far: the builder's messages and the agent's replies. */
export function chatDigest(state: StateStore, conversationId: ConversationId): string {
  const lines: string[] = [];
  for (const item of listItems(state.db, conversationId, {})) {
    if (item.kind === ConversationItemKind.Message)
      lines.push(`Builder: ${parseItemBody(item.kind, item.body).text}`);
    else if (item.kind === ConversationItemKind.AgentMessage && !item.partial)
      lines.push(`You: ${parseItemBody(item.kind, item.body).text}`);
  }
  if (lines.length === 0) return '';
  let text = lines.join('\n\n');
  if (text.length > DIGEST_MAX_CHARS) text = `…${text.slice(text.length - DIGEST_MAX_CHARS)}`;
  return `This chat continues in a fresh session. What was said so far:\n\n${text}`;
}
