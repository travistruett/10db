import {
  Approval,
  approvalOf,
  LimitName,
  SkipKind,
  SkipSource,
  type ConversationId,
  type TaskId,
  type JudgeKind,
  DeniedBy,
  PermissionChoice,
  Provider,
  MCP_TOOL_GRANT_DETAIL,
  UNSANDBOXED_DETAIL,
  QuestionCategory,
  Urgency,
  type InboxAnswer,
  type InboxItemDto,
  type InboxItemId,
  type HazardDef,
  type InboxOption,
  type McpToolGrant,
  type ProjectId,
  type SessionId,
  type ShapeId,
  type WorkstreamId,
  DEPS_HAZARD,
  commandParagraph,
  visibleLine,
} from '@10db/contracts';
import { getInboxItem, listPermissionRules, updateInboxItem } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import { builderCommandLine, type BuilderRefusal, type BuilderRun, type Git } from '../git';
import {
  firstUnread,
  hazardHit,
  passGitCall,
  runsInBackground,
  runsOutsideSandbox,
  startsEndlessBackgroundLoop,
  stringField,
  unreadableHazard,
  type PassGitCall,
} from '../guard';
import type { Logger } from '../log';
import {
  ALLOWED_WRITES_KEY,
  allowedWriteHash,
  allowedWritesIn,
  ESCALATED_KEY,
  EXACT_WRITE_KEY,
  foundHostFile,
  matchPermissionRule,
  mcpToolGrant,
  storableRule,
} from '../permissions';
import { takeFoundHostsReading } from '../registries';
import {
  isEqualOrUnder,
  isSecretOnCard,
  outsideCopyRefusal,
  readAccess,
  readPathsOf,
  singleQuoted,
  writeAccess,
  writeSecretRead,
  type FileAccessContext,
} from '../sandbox';
import { readCheckoutText, type ToolDecision, type ToolRequest } from '../sessions';
import {
  answerAway,
  callKey,
  grantCallSummary,
  grantTargetOf,
  isGrantedCall,
  projectGrantedCalls,
  routedToPerson,
  skipMessage,
  type LimitAt,
  type SkipRecorder,
} from '../trust';
import { foundHostReason } from './gate-host-card';
import { leftWithBuilder } from './builder-card';
import type { LimitNotes } from './hook-judge';
import {
  GRANT_CALL_DETAIL,
  LIMIT_DETAIL,
  limitCardTitle,
  limitOptions,
  NOTE_NEEDED_DETAIL,
} from './limit-card';
import { AnsweredAwayError, ParkedError, type InboxService } from './service';

export interface WaitObserver {
  onWaitStart(item: InboxItemDto): void;
  onWaitEnd(item: InboxItemDto): void;
}

/** Whose session asks: a lane's workstream, or a conversation (Plan's), which offers no workstream rule. */
type BrokerOwner =
  | {
      readonly workstreamId: WorkstreamId;
      readonly conversationId?: never;
      readonly shapeId?: never;
    }
  | {
      readonly workstreamId: null;
      readonly conversationId: ConversationId;
      readonly shapeId?: ShapeId;
    };

type BrokerContext = BrokerOwner & {
  /** A chat's session: the builder's no reaches it as a chat's denial text. */
  readonly chat?: true;
  readonly projectId: ProjectId;
  readonly sessionId: SessionId;
  readonly observer: WaitObserver;
  readonly signal: AbortSignal;
  /**
   * The repo MCP servers this session runs, each with the config hash the builder approved (server name to
   * hash). A server grant matches only at that hash, and only a tool of one of these servers is offered one.
   * Absent for a session that runs none (a Plan conversation).
   */
  readonly mcpApproved?: Readonly<Record<string, string>>;
  /**
   * An `allow_once` answered after the workstream was parked: the first identical call is allowed, and an
   * edit's write is recorded on the card it answered (`cardId`).
   */
  readonly allowOnce?: {
    readonly toolName: string;
    readonly summary: string;
    readonly cardId?: InboxItemId;
  } | null;
  /**
   * Present for a sandboxed lane: its commands run without a card unless they are hazards, its
   * unlisted hosts are refused and asked about, and its file tools are judged by real path.
   */
  readonly sandbox?: {
    readonly fileAccess: FileAccessContext;
    readonly hazards: readonly HazardDef[];
    /**
     * Every command that reaches the broker is asked about, hazard or not: a Plan conversation's
     * read-only commands are settled by its PreToolUse hook, and anything else is the builder's call.
     */
    readonly commandsAsk?: boolean;
    /**
     * Present for an attended chat that may run one command outside its sandbox (`dangerouslyDisableSandbox`):
     * the builder is asked about that exact command. `mayRun` says why it may not run now (null: it may), at
     * the call and again at the builder's yes. Absent, such a call is refused.
     */
    readonly unsandboxed?: {
      /** The agent that asks, named on the card. */
      readonly agent: Provider;
      readonly mayRun: () => string | null;
      /**
       * The session's count of calls that could change something, which also moves when its turn ends or another
       * chat joins the checkout: a remembered command lasts until it moves. `toolUseId` is the asking call's,
       * whose own sandboxed attempt (a Codex escalation's) does not count.
       */
      readonly changes: (toolUseId: string | null) => number;
      /** Counts a command the builder allowed to run outside the sandbox: it may have changed anything. */
      readonly bump: () => void;
      /** Whether a background task or job is running now, which may still write. */
      readonly background: () => boolean;
      /**
       * False once the session started something in the background, and while something that can write
       * the checkout shares it (not a waiting chat, nor a closed pass waiting for its merge): no command
       * is remembered then.
       */
      readonly remembers: () => boolean;
      /** The checkout's HEAD and working tree now, as one value; null when they can't be read. */
      readonly checkoutState: () => Promise<string | null>;
    };
    /**
     * Where an allowed Read of the checkout's secret is served from (`LaneSession.secretReadsDir`):
     * Claude Code's deny rule on the secret stays, so the Read runs on a copy there instead.
     */
    readonly secretReadsDir?: string;
  };
  /**
   * Present for a pass: a plain commit, push or merge (`passGitCall`) gets a card the builder may
   * allow once, as in Claude Code. Once allowed, 10db runs it outside the sandbox with their git and
   * credentials, and the call replays what it printed and how it ended.
   */
  readonly passGit?: {
    readonly baseBranch: string;
    /** Runs the allowed call as the builder (`runPassGit`), or says why 10db still won't. */
    run(call: Extract<PassGitCall, { kind: 'run' }>): Promise<BuilderRun | BuilderRefusal>;
  };
  /**
   * Present for a lane nobody watches (trust line §5): no call waits on a card. What would raise one
   * is skipped and recorded, unless the builder approved that exact call (Run these now).
   */
  readonly unattended?: {
    readonly judge: JudgeKind;
    readonly checkout: string;
    readonly approvedKeys: readonly string[];
    readonly skips: SkipRecorder;
    /** The run's task, whose question routes say who still answers a question. */
    readonly taskId: TaskId;
    readonly projectId: ProjectId;
  };
  /**
   * The limits 10db's judge stopped calls at in this session (`createHookJudge`): a noted call is asked with
   * the trust line's three answers, and no stored rule answers it.
   */
  readonly limits?: LimitNotes;
};

const ALLOWING: readonly string[] = [
  PermissionChoice.AllowOnce,
  PermissionChoice.AllowWorkstream,
  PermissionChoice.AllowProject,
  PermissionChoice.AllowChat,
  PermissionChoice.AllowMcpServer,
  PermissionChoice.AlwaysInProject,
];

const AskUserQuestionInput = z.looseObject({
  questions: z
    .array(
      z.looseObject({
        question: z.string().min(1),
        header: z.string().default(''),
        options: z
          .array(z.looseObject({ label: z.string().min(1), description: z.string().default('') }))
          .min(2)
          .max(4),
      }),
    )
    .min(1)
    .max(4),
});

const ONLY_ONCE = 'This command has no safe rule to store, so it can only be allowed once';

function permissionOptions(storable: boolean): InboxOption[] {
  return [
    { label: PermissionChoice.AllowOnce, description: 'Allow this call once' },
    {
      label: PermissionChoice.AllowWorkstream,
      description: storable ? 'Allow for the rest of this workstream' : ONLY_ONCE,
    },
    {
      label: PermissionChoice.AllowProject,
      description: storable ? 'Always allow in this project (records a decision)' : ONLY_ONCE,
    },
    { label: PermissionChoice.Deny, description: 'Deny; your note is passed to the agent' },
  ];
}

/** The option a project MCP tool's card adds: the whole server, as far as it listed tools when the card was raised. */
function serverOption(grant: McpToolGrant): InboxOption {
  return {
    label: PermissionChoice.AllowMcpServer,
    description: `Always allow every ${grant.name} tool in this project: the ${String(grant.tools.length)} it lists now. A tool it adds later, or a change to its approved config, asks again (records a decision)`,
  };
}

/** A card whose call is never stored as a rule: allow it this once, or deny it. */
const ONCE_OPTIONS: readonly InboxOption[] = permissionOptions(false).filter(
  (o) => o.label === PermissionChoice.AllowOnce || o.label === PermissionChoice.Deny,
);

/** The name a card gives the agent that asks. */
const AGENT_NAME: Readonly<Record<Provider, string>> = {
  [Provider.Claude]: 'Claude',
  [Provider.Codex]: 'Codex',
};

/** A chat's card for a command outside the sandbox: allow once, for this exact command again in this turn, or deny. */
const chatOnceOptions = (agent: string): readonly InboxOption[] => [
  { label: PermissionChoice.AllowOnce, description: 'Run this command outside the sandbox once' },
  {
    label: PermissionChoice.AllowChat,
    description: `Again in this turn, until your checkout changes or ${agent} runs another command`,
  },
  { label: PermissionChoice.Deny, description: 'Deny; your note is passed to the agent' },
];

const OUTSIDE_CARD_TITLE = 'Run this outside the sandbox?';
/** How much of what the agent says a command is for the card quotes. */
const SAID_MAX = 300;
const OUTSIDE_CARD_WARNING =
  'It runs with your full rights: it can read and write anywhere you can.';
const OUTSIDE_NOT_AVAILABLE =
  'A command outside the sandbox is not available in this session. Run it inside the sandbox.';

const NETWORK_TOOL = 'SandboxNetworkAccess';
const READ_FAMILY: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS']);
const EDIT_FAMILY: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** The Monitor input keys a card-free call may carry; any other (`ws`, or one added later) cards. */
const MONITOR_INPUT_KEYS: ReadonlySet<string> = new Set(['command', 'description', 'timeout_ms']);

const HOST_CARD_BODY =
  'The command was refused. Allow the host for the project and the next session gets it; allow once only reaches a session that is still running.';
// pnpm 12 locks its store in a fixed `/tmp/pnpm-store-operation-locks-<uid>`, whatever its settings say.
// Lanes can't write it: it is shared with every other lane and the builder's own pnpm.
const PNPM_CARD_BODY =
  "pnpm 12 locks its store in a /tmp directory shared with every lane and your own pnpm, which a lane can't write. Approving lets the command run, and it will fail on that lock. Run it yourself, or use npm.";

/** What allowing a pass's commit, push or merge does: a commit's hooks run contained, a push runs none. */
function passGitCardBody(call: Extract<PassGitCall, { kind: 'run' }>): string {
  const pushes = call.argv[0] === 'gh' || call.argv[1] === 'push';
  const how = pushes
    ? "10db runs it outside the sandbox with your git and your credentials, and runs none of the repository's hooks for it (its pre-push hook included)"
    : "10db runs it with your git identity inside the sandbox, where the repository's hooks run too but can write only the checkout and its history, and no credential of yours reaches them";
  return `Allowing it runs this call once: ${how}. The agent sees what it printed. A force push and a push to main or the base branch stay refused.`;
}

const LOOP_CARD_BODY =
  'This command runs something that never ends (a loop with no exit, `yes`, or the like) in the background, behind an `&` or the Bash tool’s own background flag: the lane goes on working while it holds a core, until something stops it. Behind an `&` it also outlives the command and the session that started it. 10db tries to stop what a session leaves when the session ends, but it cannot promise to find all of it (a job that leaves the command’s process tree and group within a second, with no file open in the lane’s temp dir, escapes), and until then a loop like this holds the Mac busy and makes gates and tests fail on timeouts. Allowing it covers this call only: the next one is asked about again.';

/** What a chat is told when the builder says no: it invites another way, and carries their note. */
function chatDenialMessage(toolName: string, summary: string, note: string | undefined): string {
  const call = summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
  const parts = [`The builder said no to this ${toolName} call: ${call}`];
  if (note) parts.push(`Note from the builder: ${note}`);
  parts.push('Try another way, or ask them.');
  return parts.join('\n');
}

/**
 * What a lane is told when the builder denies a call. It names the call and says the denial covers
 * its equivalents, because a lane that reads a refusal as being about one spelling tries the next
 * (a `yes` loop denied, then a `while :` loop).
 */
export function denialMessage(toolName: string, summary: string, note: string | undefined): string {
  const call = summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
  const parts = [
    `The builder denied this ${toolName} call: ${call}`,
    'The denial covers any equivalent: the same effect written another way (another program, a loop, a script, a wrapper or a different tool) is denied too. Do not retry it or a variant of it; work without it, or ask the builder with ask_human what they would allow.',
  ];
  if (note) parts.push(`Note from the builder: ${note}`);
  return parts.join('\n');
}

const NetworkInput = z.looseObject({ host: z.string().min(1) });

/**
 * A file tool whose path the broker cannot judge is refused, never asked about: a card would carry
 * no real path, so a stored unscoped rule could allow it. The guard refuses these calls too.
 */
const UNJUDGED_PATH: ToolDecision = {
  behavior: 'deny',
  message: "10db could not judge this call's path.",
  by: DeniedBy.TenDb,
};

/** What the broker asks about once a sandboxed call needs a person: the card's text and the real paths it names. */
interface Ask {
  readonly summary: string;
  readonly body?: string;
  readonly realPaths?: readonly string[];
  /**
   * Only ever allowed once: no stored rule answers it and the card offers no rule to store, so the
   * next such call is asked about again (an endless background loop).
   */
  readonly onceOnly?: boolean;
  /** What an unattended lane records it as, when it is skipped. */
  readonly kind?: SkipKind;
  /** The card's title, where the default `Allow <tool>?` doesn't say it. */
  readonly title?: string;
  /**
   * A chat's command outside the sandbox: only the builder answers it, so no stored rule, carried allowance or
   * project grant does. The one yes that is remembered is this exact call, for this session.
   */
  readonly chatOnce?: boolean;
}

/** Why an unattended lane skipped what would have been a card, by kind; null where the kind says it. */
function unattendedReason(kind: SkipKind, path: string | null): string {
  switch (kind) {
    case SkipKind.Escalation:
      return 'Auto mode sent this call to a person, and nobody is watching this task.';
    case SkipKind.HazardCard:
      return 'This changes a dependency or a migration; use the install_dependencies tool, which runs it for the task.';
    case SkipKind.UnreadHazard:
      return "10db can't read whether this changes a dependency or a migration this task hasn't claimed. Write the command out plainly, or claim the hazard first.";
    case SkipKind.EndlessLoop:
      return 'This starts something in the background that never ends.';
    case SkipKind.ReadOutside:
      return `${path ?? 'This path'} is outside what a task reads without asking. Read it with a Bash command, which the sandbox bounds.`;
    case SkipKind.EditorConfigWrite:
      return `${path ?? 'This path'} is editor config, which runs outside the sandbox when the builder opens the folder.`;
    case SkipKind.PassGit:
      return 'A commit, push or merge waits for the builder in a pass; nobody is here to allow it.';
    case SkipKind.DefaultModeCard:
    case SkipKind.Classifier:
    case SkipKind.CantRunInLane:
    case SkipKind.ConfigWrite:
    case SkipKind.Deploy:
    case SkipKind.DockerOff:
    case SkipKind.HomeRcWrite:
    case SkipKind.Host:
    case SkipKind.MonitorNoCommand:
    case SkipKind.MonitorSocket:
    case SkipKind.Question:
    case SkipKind.SafetyCheck:
    case SkipKind.SecretRead:
    case SkipKind.UnknownTool:
    case SkipKind.UnreadEditPath:
    case SkipKind.WebOrMcp:
      return "This call needs a person's approval on this account, and nobody is watching this task.";
  }
}

const unattendedLimit = (kind: SkipKind): LimitName | null =>
  kind === SkipKind.MonitorSocket ? LimitName.SendsDataOut : null;

/**
 * A command nested deeply enough to overflow the stack in a shell scanner is one nothing can
 * read, so a person is asked. The name is checked because the error may come from another realm.
 */
function isTooDeep(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'RangeError';
}

/** The result of `read`, or `fallback` when the command is too deeply nested to scan. */
function unlessTooDeep<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch (cause) {
    if (isTooDeep(cause)) return fallback;
    throw cause;
  }
}

/** The key a chat's remembered command is looked up by: the tool and the call as the card shows it. */
const chatCallKey = (toolName: string, summary: string, cwd: string | undefined): string =>
  `${toolName}\u0000${cwd ?? ''}\u0000${summary}`;

function summarize(req: ToolRequest): string {
  return grantCallSummary(req.toolName, req.input);
}

/**
 * The file an edit call writes, for its card's detail: the watcher reads it to tell that the builder allowed
 * the write and raises no stray-write card for it. A sandboxed lane's is the real path the judge resolved.
 */
function editedPath(req: ToolRequest, ask: Ask | null): string | null {
  if (!EDIT_FAMILY.has(req.toolName)) return null;
  const [real, ...more] = ask?.realPaths ?? [];
  return real !== undefined && more.length === 0
    ? real
    : (stringField(req.input, 'file_path') ?? stringField(req.input, 'notebook_path'));
}

/**
 * An edit card's detail: its file, and the mark that it excuses only the exact write its allowed call makes
 * (`recordAllowedWrite`), so the watcher never takes another lane's write to the same file for it.
 */
function editDetail(req: ToolRequest, ask: Ask | null): Record<string, string | boolean> {
  const path = editedPath(req, ask);
  return path === null ? {} : { path, [EXACT_WRITE_KEY]: true };
}

/** Decides every canUseTool call: stored rules first, then a card for the builder. Never an LLM. */
export function createPermissionBroker(
  deps: {
    readonly state: StateStore;
    readonly inbox: InboxService;
    /** Reads a project's package files from its default branch, for a project with no reading yet. */
    readonly git: Pick<Git, 'commitAt' | 'folderAt' | 'fileAt'>;
    readonly logger: Logger;
  },
  ctx: BrokerContext,
): (req: ToolRequest) => Promise<ToolDecision> {
  let allowOnce = ctx.allowOnce ?? null;
  // The commands outside the sandbox the builder allowed for this session: forgotten when it ends.
  // Each with the session's change count and the checkout's state when it was last allowed.
  const chatAllowed = new Map<string, { readonly changes: number; readonly checkout: string }>();
  const isChat = ctx.chat === true;
  /** Why the chat's command may not run outside the sandbox now; null when it may. */
  const outsideRefusal = (): string | null => {
    const outside = ctx.sandbox?.unsandboxed;
    return outside === undefined ? OUTSIDE_NOT_AVAILABLE : outside.mayRun();
  };
  /** The agent a chat's card for a command outside the sandbox names. */
  const agentName = (): string => AGENT_NAME[ctx.sandbox?.unsandboxed?.agent ?? Provider.Claude];
  const denied = (toolName: string, summary: string, note: string | undefined): string =>
    isChat ? chatDenialMessage(toolName, summary, note) : denialMessage(toolName, summary, note);
  const owner: BrokerOwner =
    ctx.workstreamId === null
      ? {
          workstreamId: null,
          conversationId: ctx.conversationId,
          ...(ctx.shapeId === undefined ? {} : { shapeId: ctx.shapeId }),
        }
      : { workstreamId: ctx.workstreamId };
  // A conversation has no workstream, so it is never offered a rule for one.
  const optionsFor = (storable: boolean): InboxOption[] =>
    permissionOptions(storable).filter(
      (o) => ctx.workstreamId !== null || o.label !== PermissionChoice.AllowWorkstream,
    );

  async function wait(item: InboxItemDto, answer: Promise<InboxAnswer>): Promise<InboxAnswer> {
    ctx.observer.onWaitStart(item);
    const result = await answer;
    ctx.observer.onWaitEnd(item);
    return result;
  }

  /**
   * A conversation that stops waiting withdraws its card: no lane resumes on a late answer, and the
   * next session asks again. A lane's card stays for its parked workstream.
   */
  /** Whether a call's card goes with the call: a conversation's, and one that waits in a hook. */
  const cardGoesWith = (req: ToolRequest): boolean =>
    ctx.workstreamId === null || req.cardGoesWithCall === true;

  async function waitOrWithdraw(
    item: InboxItemDto,
    answer: Promise<InboxAnswer>,
    withCall = ctx.workstreamId === null,
  ): Promise<InboxAnswer> {
    try {
      return await wait(item, answer);
    } catch (error) {
      if (error instanceof ParkedError && withCall) deps.inbox.withdraw(item.id);
      throw error;
    }
  }

  async function askQuestions(req: ToolRequest): Promise<ToolDecision> {
    const parsed = AskUserQuestionInput.safeParse(req.input);
    if (!parsed.success) {
      return {
        behavior: 'deny',
        message: 'AskUserQuestion input was not understood; use ask_human instead.',
        by: DeniedBy.TenDb,
      };
    }
    const answers: Record<string, string> = {};
    const away = ctx.unattended;
    if (
      away !== undefined &&
      !routedToPerson(
        deps.state.db,
        { id: away.taskId, projectId: ctx.projectId },
        { category: QuestionCategory.Other, topic: null },
      )
    ) {
      for (const q of parsed.data.questions)
        answers[q.question] = answerAway(away, req.toolName, q.question);
      return { behavior: 'allow', updatedInput: { ...req.input, answers } };
    }
    for (const q of parsed.data.questions) {
      const { item, answer } = deps.inbox.ask({
        projectId: ctx.projectId,
        ...owner,
        sessionId: ctx.sessionId,
        kind: 'question',
        title: q.question,
        body: q.header,
        options: q.options.map((o) => ({ label: o.label, description: o.description })),
        recommendation: null,
        category: QuestionCategory.Other,
        urgency: Urgency.Normal,
        detail: null,
        signal: ctx.signal,
      });
      // A rule's person with no Slack leaves the card with the builder, whom this lane never waits on.
      if (away !== undefined && leftWithBuilder(getInboxItem(deps.state.db, item.id)))
        deps.inbox.answerAwayWaits(item.id, (waiting) => waiting === ctx.sessionId);
      let result;
      try {
        result = await wait(item, answer);
      } catch (error) {
        // The question was left with the builder, and nobody watches this task.
        if (!(error instanceof AnsweredAwayError) || away === undefined) throw error;
        ctx.observer.onWaitEnd(item);
        answers[q.question] = answerAway(away, req.toolName, q.question);
        continue;
      }
      answers[q.question] = result.note ? `${result.choice} (${result.note})` : result.choice;
    }
    return { behavior: 'allow', updatedInput: { ...req.input, answers } };
  }

  /**
   * Records on the card `cardId` the file the allowed edit call `req` leaves, for this lane: the file as it is
   * now with the call applied as Claude Code applies it, hashed. Claude Code writes it next, so the watcher
   * excuses that exact write and no other lane's to the same file; a write that lands in between makes the
   * call's own write differ, and it is carded. A call whose result can't be told (a NotebookEdit, a file that
   * can't be read) records nothing, and its write is carded.
   */
  function recordAllowedWrite(cardId: InboxItemId, req: ToolRequest, ask: Ask | null): void {
    const lane = ctx.workstreamId;
    if (lane === null) return;
    const path = editedPath(req, ask);
    if (path === null) return;
    const hash = allowedWriteHash(req.toolName, req.input, path);
    if (hash === undefined) return;
    try {
      deps.state.write((w) => {
        const item = getInboxItem(w.tx, cardId);
        const detail = item.detail ?? {};
        updateInboxItem(w, cardId, {
          detail: {
            ...detail,
            [ALLOWED_WRITES_KEY]: { ...allowedWritesIn(detail), [lane]: hash },
          },
        });
      });
    } catch (error) {
      // Without the record the write is carded, never excused: the builder sees it again.
      deps.logger.warn({ err: error, cardId }, 'could not record the write an allowed edit makes');
    }
  }

  /** A card an unattended lane can't wait on: skipped and recorded, or allowed when approved. */
  function skipUnattended(
    req: ToolRequest,
    ask: Ask | null,
    unattended: NonNullable<BrokerContext['unattended']>,
  ): ToolDecision {
    const kind = req.escalated ? SkipKind.Escalation : (ask?.kind ?? SkipKind.DefaultModeCard);
    const key = callKey(req.toolName, req.input, unattended.checkout);
    if (approvalOf(kind, false) === Approval.Exact && unattended.approvedKeys.includes(key))
      return { behavior: 'allow' };
    const limit = unattendedLimit(kind);
    const reason = unattendedReason(kind, ask?.realPaths?.[0] ?? null);
    unattended.skips.record({
      toolName: req.toolName,
      toolUseId: req.toolUseId,
      callKey: key,
      summary: ask?.summary ?? summarize(req),
      kind,
      limit,
      reason,
      source: SkipSource.Broker,
    });
    return { behavior: 'deny', message: skipMessage(limit, reason), by: DeniedBy.TenDb };
  }

  async function askPermission(
    req: ToolRequest,
    ask: Ask | null = null,
    notedIn?: LimitAt,
  ): Promise<ToolDecision> {
    const chatOnce = ask?.chatOnce === true;
    // A command outside the sandbox is the builder's alone, whatever a limit note says about it.
    const noted = chatOnce ? undefined : notedIn;
    if (chatOnce) {
      const key = chatCallKey(req.toolName, ask.summary, req.cwd);
      const outside = ctx.sandbox?.unsandboxed;
      const remembers = outside?.remembers() !== false;
      if (!remembers) chatAllowed.clear();
      const seen = chatAllowed.get(key);
      // Anything that may have changed since (a change, another command allowed to run outside, a job started
      // or still running, the turn's end, HEAD or a file of the checkout's) makes the same command ask again.
      const unchanged = (): boolean =>
        outside !== undefined &&
        outside.remembers() &&
        seen?.changes === outside.changes(req.toolUseId) &&
        !outside.background();
      // Read again after the checkout's git read: a chat that joins the checkout meanwhile ends the yes.
      const remembered =
        unchanged() &&
        seen !== undefined &&
        outside !== undefined &&
        (await outside.checkoutState()) === seen.checkout &&
        unchanged();
      const refusal = outsideRefusal();
      if (refusal !== null) return { behavior: 'deny', message: refusal, by: DeniedBy.TenDb };
      if (remembered) return { behavior: 'allow' };
    }
    const rules = listPermissionRules(deps.state.db, ctx.projectId, ctx.workstreamId);
    const paths = ask?.realPaths === undefined ? undefined : { realPaths: ask.realPaths };
    const onceOnly = ask?.onceOnly === true;
    // A call a judge handed to a person (an escalation, or a limit 10db's judge noted) is answered by a
    // person, never by a stored grant or a carried allowance.
    const judged = req.escalated || noted !== undefined;
    if (
      !judged &&
      !onceOnly &&
      !chatOnce &&
      unlessTooDeep(() => matchPermissionRule(req, rules, paths, ctx.mcpApproved), undefined)
    ) {
      return { behavior: 'allow' };
    }
    const summary = ask?.summary ?? summarize(req);
    if (
      !judged &&
      !chatOnce &&
      allowOnce?.toolName === req.toolName &&
      allowOnce.summary === summary
    ) {
      const { cardId } = allowOnce;
      allowOnce = null;
      if (cardId !== undefined) recordAllowedWrite(cardId, req, ask);
      return { behavior: 'allow' };
    }
    // The builder's Always in this project on this very call, matched as written.
    if (
      judged &&
      !onceOnly &&
      !chatOnce &&
      isGrantedCall(projectGrantedCalls(deps.state.db, ctx.projectId), req.toolName, req.input)
    )
      return { behavior: 'allow' };
    if (ctx.unattended !== undefined) return skipUnattended(req, ask, ctx.unattended);
    const storable =
      unlessTooDeep(() => storableRule(req.toolName, summary), undefined) !== undefined;
    // Only a project MCP server's tool, listed by this session, whose server runs at an approved config.
    const grant =
      onceOnly || ctx.mcpApproved === undefined || req.listedTools === undefined
        ? null
        : mcpToolGrant(req.toolName, req.listedTools, ctx.mcpApproved);
    // Always in this project keeps the call itself only when it is short enough to keep whole.
    const grantCall = grantCallSummary(req.toolName, req.input);
    const noteNeeded = judged && !onceOnly && grantTargetOf(null, grantCall, req.toolName) === null;
    // A once-only call offers no rule to store, Always in this project included.
    const options = chatOnce
      ? chatOnceOptions(agentName()).filter(
          (o) =>
            o.label !== PermissionChoice.AllowChat ||
            ctx.sandbox?.unsandboxed?.remembers() !== false,
        )
      : onceOnly
        ? ONCE_OPTIONS
        : judged
          ? limitOptions(noteNeeded)
          : optionsFor(storable);
    const { item, answer } = deps.inbox.ask({
      projectId: ctx.projectId,
      ...owner,
      sessionId: ctx.sessionId,
      kind: 'permission',
      title: ask?.title ?? (noted === undefined ? `Allow ${req.toolName}?` : limitCardTitle(noted)),
      body: noted === undefined ? (ask?.body ?? summary) : summary,
      // The service refuses a choice the card does not offer, so a once-only card stores no rule.
      options:
        grant === null
          ? options
          : options.flatMap((o) =>
              o.label === PermissionChoice.Deny ? [serverOption(grant), o] : [o],
            ),
      recommendation: null,
      category: QuestionCategory.Access,
      urgency: Urgency.Normal,
      detail: {
        toolName: req.toolName,
        summary,
        // What Always in this project quotes, as the hook judge names the call when it matches it.
        ...(judged && !onceOnly ? { [GRANT_CALL_DETAIL]: grantCall } : {}),
        ...(grant === null ? {} : { [MCP_TOOL_GRANT_DETAIL]: grant }),
        ...editDetail(req, ask),
        ...(chatOnce ? { [UNSANDBOXED_DETAIL]: true } : {}),
        ...(req.escalated ? { [ESCALATED_KEY]: true } : {}),
        ...(noted?.limit == null ? {} : { [LIMIT_DETAIL]: noted.limit }),
        ...(noteNeeded ? { [NOTE_NEEDED_DETAIL]: true } : {}),
      },
      signal: ctx.signal,
      // An edit's result depends on the file it lands on. Folded with another lane's, both lanes would read the
      // file on the one answer, before either writes, and the second write would match neither record.
      // A Write's content doesn't depend on the file, so Writes still fold.
      foldPerLane: EDIT_FAMILY.has(req.toolName) && req.toolName !== 'Write',
      // A conversation's card goes with its call: Claude Code cancels the call when the turn is stopped.
      // So does one that waits in the PreToolUse hook, which Claude Code may cancel.
      ...(cardGoesWith(req) ? { signal: AbortSignal.any([ctx.signal, req.signal]) } : {}),
      // The escalation is only in the detail, so without this an escalated and an ordinary ask would share a card.
      escalated: req.escalated,
    });
    const result = await waitOrWithdraw(item, answer, cardGoesWith(req));
    // inbox.answer has already written any rule this choice implies, in the answer's transaction.
    if (ALLOWING.includes(result.choice)) {
      if (chatOnce) {
        // The turn may have ended or the checkout moved while the card waited: the yes is read again.
        const refusal = outsideRefusal();
        if (refusal !== null) return { behavior: 'deny', message: refusal, by: DeniedBy.TenDb };
        // A command allowed now may change anything, so what was remembered before it asks again.
        const outside = ctx.sandbox?.unsandboxed;
        outside?.bump();
        if (
          outside !== undefined &&
          result.choice === PermissionChoice.AllowChat &&
          outside.remembers() &&
          !outside.background()
        ) {
          // The count first: a change while the checkout is read moves it, so the yes is never newer than both.
          const changes = outside.changes(req.toolUseId);
          const checkout = await outside.checkoutState();
          const key = chatCallKey(req.toolName, summary, req.cwd);
          if (checkout === null) chatAllowed.delete(key);
          else chatAllowed.set(key, { changes, checkout });
        }
      }
      recordAllowedWrite(item.id, req, ask);
      return { behavior: 'allow' };
    }
    return {
      behavior: 'deny',
      message: denied(req.toolName, summary, result.note),
      // The builder answered the card with Deny: the one refusal that is theirs.
      by: DeniedBy.Builder,
    };
  }

  const hostsAsked = new Set<string>();
  const hostsAllowedOnce = new Set<string>();

  /** A host the lane's command reached for: allowed by a rule or a one-time allowance, else refused and asked about once. */
  async function judgeHost(req: ToolRequest): Promise<ToolDecision> {
    const parsed = NetworkInput.safeParse(req.input);
    if (!parsed.success) {
      return {
        behavior: 'deny',
        message: 'The network request named no host, so 10db refused it.',
        by: DeniedBy.TenDb,
      };
    }
    const host = parsed.data.host.toLowerCase();
    const rules = listPermissionRules(deps.state.db, ctx.projectId, ctx.workstreamId);
    // A sandboxed call: a host names no path, and an unscoped network rule covers no host.
    if (
      matchPermissionRule({ toolName: NETWORK_TOOL, input: { host } }, rules, { realPaths: [] })
    ) {
      return { behavior: 'allow' };
    }
    if (hostsAllowedOnce.delete(host)) return { behavior: 'allow' };
    if (allowOnce?.toolName === NETWORK_TOOL && allowOnce.summary === host) {
      allowOnce = null;
      return { behavior: 'allow' };
    }
    if (!hostsAsked.has(host)) {
      hostsAsked.add(host);
      // A project added before 10db kept a reading of its package files gets one, from the default branch.
      await takeFoundHostsReading(deps, ctx.projectId);
      // A project file that needs the host is a reason to allow it, not a grant.
      const file = foundHostFile(deps.state.db, ctx.projectId, host);
      const { item, answer } = deps.inbox.ask({
        projectId: ctx.projectId,
        ...owner,
        sessionId: ctx.sessionId,
        kind: 'permission',
        title: `Allow network access to ${host}?`,
        body: file === null ? HOST_CARD_BODY : `${foundHostReason(file, host)}\n${HOST_CARD_BODY}`,
        options: permissionOptions(true).filter(
          (o) => o.label !== PermissionChoice.AllowWorkstream,
        ),
        recommendation: file === null ? null : PermissionChoice.AllowProject,
        category: QuestionCategory.Access,
        urgency: Urgency.Normal,
        detail: { toolName: NETWORK_TOOL, summary: host },
        signal: ctx.signal,
      });
      // A conversation's host card goes when the conversation stops waiting: no lane resumes on it.
      if (ctx.workstreamId === null) {
        const withdraw = (): void => {
          deps.inbox.withdraw(item.id);
        };
        if (ctx.signal.aborted) withdraw();
        else ctx.signal.addEventListener('abort', withdraw, { once: true });
      }
      // The lane keeps working while the card is open, so nothing waits on it and the workstream
      // never enters WAITING_HUMAN. A parked or cancelled card adds nothing.
      void answer.then(
        (result) => {
          if (result.choice === PermissionChoice.AllowOnce) hostsAllowedOnce.add(host);
        },
        () => undefined,
      );
    }
    return {
      behavior: 'deny',
      message: `10db asked the builder about ${host}. Retry after the card is answered, or work without it.`,
      by: DeniedBy.TenDb,
    };
  }

  /**
   * A sandboxed Bash command runs without a card unless it is a hazard or something unread could
   * make it one: a program 10db cannot name, a script it cannot read, or an argument that could
   * select a hazard form. An unread argument to a program with no hazard form does not matter.
   */
  function judgeBash(
    req: ToolRequest,
    sandbox: NonNullable<BrokerContext['sandbox']>,
  ): ToolDecision | Ask {
    const command = req.input['command'];
    if (typeof command !== 'string') return { summary: summarize(req) };
    if (runsOutsideSandbox(req.input)) {
      if (sandbox.unsandboxed === undefined)
        return { behavior: 'deny', message: OUTSIDE_NOT_AVAILABLE, by: DeniedBy.TenDb };
      // What the agent says the command is for stays one quoted line with its hidden characters shown: a paragraph
      // of its own, or a bidi or format character, could pass for 10db's words.
      const said = (stringField(req.input, 'description') ?? '').replace(/\s+/g, ' ').trim();
      const why = visibleLine(said.length > SAID_MAX ? `${said.slice(0, SAID_MAX)}…` : said);
      return {
        summary: command,
        title: OUTSIDE_CARD_TITLE,
        // The command is the card's detail.summary, shown on its own in a code block; the body is only what
        // the agent says and 10db's warning, so nothing in the command can pass for either.
        body: [why === '' ? '' : `${agentName()} says: “${why}”`, OUTSIDE_CARD_WARNING]
          .filter((part) => part !== '')
          .join('\n\n'),
        chatOnce: true,
      };
    }
    let hit: ReturnType<typeof hazardHit>;
    let unread: ReturnType<typeof firstUnread>;
    let unreadable: string | null;
    try {
      hit = hazardHit(command, sandbox.hazards);
      unread = firstUnread(command, sandbox.hazards);
      unreadable = unreadableHazard(command, sandbox.hazards);
    } catch (cause) {
      if (isTooDeep(cause)) return { summary: command };
      throw cause;
    }
    // A background call never blocks the lane, so its loop holds a core while the lane goes on.
    if (
      startsEndlessBackgroundLoop(command, {
        background: req.toolName === 'Monitor' || runsInBackground(req.input),
      })
    ) {
      return {
        summary: command,
        body: [LOOP_CARD_BODY, commandParagraph(command)].join('\n\n'),
        onceOnly: true,
        kind: SkipKind.EndlessLoop,
      };
    }
    if (sandbox.commandsAsk === true) return { summary: command };
    if (hit === null && !req.escalated && unread === null && unreadable === null)
      return { behavior: 'allow' };
    const kind = hit !== null ? SkipKind.HazardCard : SkipKind.UnreadHazard;
    return hit?.name === DEPS_HAZARD && hit.words[0] === 'pnpm'
      ? { summary: command, body: [PNPM_CARD_BODY, commandParagraph(command)].join('\n\n'), kind }
      : { summary: command, kind };
  }

  /**
   * A sandboxed Monitor call gets the checks a Bash command gets and no more: its command runs inside
   * the sandbox, so it is judged as a Bash command, and any input key beyond command, description
   * and timeout_ms is asked about (`ws` opens a socket from Claude Code's own process, outside the
   * sandbox's network proxy).
   */
  function judgeMonitor(
    req: ToolRequest,
    sandbox: NonNullable<BrokerContext['sandbox']>,
  ): ToolDecision | Ask | null {
    const command = req.input['command'];
    if (typeof command !== 'string') return null;
    if (!Object.keys(req.input).every((key) => MONITOR_INPUT_KEYS.has(key))) {
      return { summary: command, kind: SkipKind.MonitorSocket };
    }
    return judgeBash(req, sandbox);
  }

  /** A read tool: protected paths are refused, the checkout and the read list are open, the rest is asked about by real path. */
  function judgeRead(
    req: ToolRequest,
    sandbox: NonNullable<BrokerContext['sandbox']>,
  ): ToolDecision | Ask {
    const inputs = readPathsOf(req.toolName, req.input);
    if (inputs.length === 0) return UNJUDGED_PATH;
    const asking: string[] = [];
    try {
      for (const path of inputs) {
        const { access, realPath } = readAccess(
          path,
          sandbox.fileAccess,
          req.toolName !== 'Read',
          req.cwd,
        );
        if (access === 'protected' || access === 'contains-protected') {
          return {
            behavior: 'deny',
            message: `${path} is a protected path; 10db never lets a lane read it.`,
            by: DeniedBy.TenDb,
          };
        }
        if (access === 'outside-copy') {
          // Never right, so never a card: the lane's paths come from its own copy.
          return {
            behavior: 'deny',
            message: outsideCopyRefusal(path, sandbox.fileAccess),
            by: DeniedBy.TenDb,
          };
        }
        if (access === 'ask') asking.push(realPath);
      }
    } catch {
      return {
        behavior: 'deny',
        message: `${req.toolName} could not be judged; 10db refuses it.`,
        by: DeniedBy.TenDb,
      };
    }
    const [first] = asking;
    if (first === undefined && !req.escalated) return { behavior: 'allow' };
    const body = asking.length > 1 ? asking.join('\n') : undefined;
    return {
      summary: first ?? summarize(req),
      ...(body === undefined ? {} : { body }),
      realPaths: asking,
      kind: SkipKind.ReadOutside,
    };
  }

  function judgeEdit(
    req: ToolRequest,
    sandbox: NonNullable<BrokerContext['sandbox']>,
  ): ToolDecision | Ask {
    const path = stringField(req.input, 'file_path') ?? stringField(req.input, 'notebook_path');
    if (path === null) return UNJUDGED_PATH;
    try {
      const { realPath, access } = writeAccess(path, sandbox.fileAccess);
      const parts = realPath.split('/');
      const editor = parts.includes('.vscode') || parts.includes('.idea');
      // Unattended, the checkout's own agent config is written without a card: none of
      // it runs before the builder approves it.
      if (
        ctx.unattended !== undefined &&
        !editor &&
        access === 'claude-protected' &&
        isEqualOrUnder(realPath, sandbox.fileAccess.checkout)
      )
        return { behavior: 'allow' };
      return {
        summary: realPath,
        realPaths: [realPath],
        ...(editor ? { kind: SkipKind.EditorConfigWrite } : {}),
      };
    } catch {
      return UNJUDGED_PATH;
    }
  }

  function isDecision(verdict: ToolDecision | Ask): verdict is ToolDecision {
    return 'behavior' in verdict;
  }

  /**
   * A pass's commit, push or merge: one card, allowed once or denied. The call then runs as the
   * builder would run it (`runPassGit`, which checks the remote and the current branch first), and
   * the agent's Bash call prints what it printed and ends as it ended.
   */
  async function runPassGit(
    req: ToolRequest,
    command: string,
    call: Extract<PassGitCall, { kind: 'run' }>,
    passGit: NonNullable<BrokerContext['passGit']>,
  ): Promise<ToolDecision> {
    // The words 10db runs: a comment or spacing on the line as written runs nothing.
    const line = builderCommandLine(call.argv);
    if (ctx.unattended !== undefined)
      return skipUnattended(req, { summary: line, kind: SkipKind.PassGit }, ctx.unattended);
    const { item, answer } = deps.inbox.ask({
      projectId: ctx.projectId,
      ...owner,
      sessionId: ctx.sessionId,
      kind: 'permission',
      title: `Allow ${call.argv.slice(0, call.argv[0] === 'gh' ? 3 : 2).join(' ')}?`,
      body: `${line}\n\n${passGitCardBody(call)}`,
      options: ONCE_OPTIONS,
      recommendation: null,
      category: QuestionCategory.Access,
      urgency: Urgency.Normal,
      detail: { toolName: req.toolName, summary: line },
      signal: ctx.signal,
      escalated: req.escalated,
    });
    const result = await waitOrWithdraw(item, answer);
    if (!ALLOWING.includes(result.choice)) {
      return {
        behavior: 'deny',
        message: denialMessage(req.toolName, command, result.note),
        by: DeniedBy.Builder,
      };
    }
    const ran = await passGit.run(call);
    if ('refused' in ran) return { behavior: 'deny', message: ran.refused, by: DeniedBy.TenDb };
    return {
      behavior: 'allow',
      updatedInput: {
        ...req.input,
        command: `printf '%s' ${singleQuoted(ran.output)}; exit ${String(ran.exitCode)}`,
      },
      ranForBuilder: {
        command: builderCommandLine(call.argv),
        exitCode: ran.exitCode,
        output: ran.output,
      },
    };
  }

  async function decide(req: ToolRequest): Promise<ToolDecision> {
    if (req.toolName === 'AskUserQuestion') return askQuestions(req);
    // 10db's judge stopped this call at a limit: 10db's own gates still refuse what they refuse, and the builder
    // answers the rest, whatever the lane's rules allow.
    const noted = req.toolUseId === null ? undefined : ctx.limits?.take(req.toolUseId);
    if (req.toolName === 'Bash' && ctx.passGit !== undefined) {
      const command = stringField(req.input, 'command');
      const call = command === null ? null : passGitCall(command, ctx.passGit.baseBranch);
      if (call?.kind === 'run') return runPassGit(req, command ?? '', call, ctx.passGit);
      if (call?.kind === 'refuse')
        return { behavior: 'deny', message: call.reason, by: DeniedBy.TenDb };
    }
    const { sandbox } = ctx;
    if (sandbox === undefined) return askPermission(req, null, noted);
    if (req.toolName === NETWORK_TOOL) return judgeHost(req);
    let verdict: ToolDecision | Ask | null = null;
    if (req.toolName === 'Bash') verdict = judgeBash(req, sandbox);
    else if (req.toolName === 'Monitor') verdict = judgeMonitor(req, sandbox);
    else if (READ_FAMILY.has(req.toolName)) verdict = judgeRead(req, sandbox);
    else if (EDIT_FAMILY.has(req.toolName)) verdict = judgeEdit(req, sandbox);
    if (verdict === null) return askPermission(req, null, noted);
    if (isDecision(verdict)) {
      if (verdict.behavior === 'deny' || noted === undefined) return verdict;
      return askPermission(req, null, noted);
    }
    const decision = await askPermission(req, verdict, noted);
    return req.toolName === 'Read' ? servedSecretRead(req, decision, verdict, sandbox) : decision;
  }

  /**
   * An allowed Read of the checkout's secret, pointed at a copy in the session's reads folder:
   * Claude Code's deny rule on the secret stays, since its Grep and Glob honour only that.
   */
  function servedSecretRead(
    req: ToolRequest,
    decision: ToolDecision,
    ask: Ask,
    sandbox: NonNullable<BrokerContext['sandbox']>,
  ): ToolDecision {
    const [real] = ask.realPaths ?? [];
    if (
      decision.behavior !== 'allow' ||
      real === undefined ||
      !isSecretOnCard(real, sandbox.fileAccess)
    )
      return decision;
    const refuse = (why: string): ToolDecision => ({
      behavior: 'deny',
      message: `${real} was allowed, but ${why}, so 10db did not read it.`,
      by: DeniedBy.TenDb,
    });
    if (sandbox.secretReadsDir === undefined) return refuse('this session has no place to read it');
    const text = readCheckoutText(sandbox.fileAccess.checkout, real);
    if (text.kind !== 'text') return refuse('it is not one plain file inside the checkout');
    try {
      return {
        behavior: 'allow',
        updatedInput: {
          ...req.input,
          file_path: writeSecretRead(sandbox.secretReadsDir, text.text),
        },
      };
    } catch {
      return refuse('its copy could not be written');
    }
  }

  return async (req) => {
    try {
      return await decide(req);
    } catch (error) {
      if (error instanceof ParkedError) {
        return {
          behavior: 'deny',
          message: 'Parked until the builder answers.',
          interrupt: true,
          by: DeniedBy.TenDb,
        };
      }
      throw error;
    }
  };
}
