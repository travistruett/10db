import {
  DeniedBy,
  PermissionChoice,
  MCP_TOOL_GRANT_DETAIL,
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
} from '@10db/contracts';
import { getInboxItem, listPermissionRules, updateInboxItem } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import type { Git } from '../git';
import {
  firstUnread,
  hazardHit,
  runsInBackground,
  startsEndlessBackgroundLoop,
  stringField,
  unreadableHazard,
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
  outsideCopyRefusal,
  readAccess,
  readPathsOf,
  writeAccess,
  type FileAccessContext,
} from '../sandbox';
import type { ToolDecision, ToolRequest } from '../sessions';
import { foundHostReason } from './gate-host-card';
import { ParkedError, type InboxService } from './service';

export interface WaitObserver {
  onWaitStart(item: InboxItemDto): void;
  onWaitEnd(item: InboxItemDto): void;
}

/** Whose session asks: a lane's workstream, or a Plan conversation, which offers no workstream rule. */
type BrokerOwner =
  | { readonly workstreamId: WorkstreamId; readonly shapeId?: never }
  | { readonly workstreamId: null; readonly shapeId: ShapeId };

type BrokerContext = BrokerOwner & {
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
  };
};

const ALLOWING: readonly string[] = [
  PermissionChoice.AllowOnce,
  PermissionChoice.AllowWorkstream,
  PermissionChoice.AllowProject,
  PermissionChoice.AllowMcpServer,
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

const LOOP_CARD_BODY =
  'This command runs something that never ends (a loop with no exit, `yes`, or the like) in the background, behind an `&` or the Bash tool’s own background flag: the lane goes on working while it holds a core, until something stops it. Behind an `&` it also outlives the command and the session that started it. 10db tries to stop what a session leaves when the session ends, but it cannot promise to find all of it (a job that leaves the command’s process tree and group within a second, with no file open in the lane’s temp dir, escapes), and until then a loop like this holds the Mac busy and makes gates and tests fail on timeouts. Allowing it covers this call only: the next one is asked about again.';

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
}

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

function summarize(req: ToolRequest): string {
  const command = req.input['command'];
  if (req.toolName === 'Bash' && typeof command === 'string') return command;
  return JSON.stringify(req.input).slice(0, 2000);
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
  const owner: BrokerOwner =
    ctx.workstreamId === null
      ? { workstreamId: null, shapeId: ctx.shapeId }
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
  async function waitOrWithdraw(
    item: InboxItemDto,
    answer: Promise<InboxAnswer>,
  ): Promise<InboxAnswer> {
    try {
      return await wait(item, answer);
    } catch (error) {
      if (error instanceof ParkedError && ctx.workstreamId === null) deps.inbox.withdraw(item.id);
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
      const result = await wait(item, answer);
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

  async function askPermission(req: ToolRequest, ask: Ask | null = null): Promise<ToolDecision> {
    const rules = listPermissionRules(deps.state.db, ctx.projectId, ctx.workstreamId);
    const paths = ask?.realPaths === undefined ? undefined : { realPaths: ask.realPaths };
    const onceOnly = ask?.onceOnly === true;
    // A call the classifier handed to a person is answered by a person, never by a stored grant.
    if (
      !req.escalated &&
      !onceOnly &&
      unlessTooDeep(() => matchPermissionRule(req, rules, paths, ctx.mcpApproved), undefined)
    ) {
      return { behavior: 'allow' };
    }
    const summary = ask?.summary ?? summarize(req);
    if (!req.escalated && allowOnce?.toolName === req.toolName && allowOnce.summary === summary) {
      const { cardId } = allowOnce;
      allowOnce = null;
      if (cardId !== undefined) recordAllowedWrite(cardId, req, ask);
      return { behavior: 'allow' };
    }
    const storable =
      unlessTooDeep(() => storableRule(req.toolName, summary), undefined) !== undefined;
    // Only a project MCP server's tool, listed by this session, whose server runs at an approved config.
    const grant =
      onceOnly || ctx.mcpApproved === undefined || req.listedTools === undefined
        ? null
        : mcpToolGrant(req.toolName, req.listedTools, ctx.mcpApproved);
    const options = onceOnly ? ONCE_OPTIONS : optionsFor(storable);
    const { item, answer } = deps.inbox.ask({
      projectId: ctx.projectId,
      ...owner,
      sessionId: ctx.sessionId,
      kind: 'permission',
      title: `Allow ${req.toolName}?`,
      body: ask?.body ?? summary,
      // The service refuses a choice the card does not offer, so a once-only card stores no rule.
      options:
        grant === null
          ? options
          : options.flatMap((o) =>
              o.label === PermissionChoice.Deny ? [serverOption(grant), o] : [o],
            ),
      recommendation: null,
      category: QuestionCategory.Environment,
      urgency: Urgency.Normal,
      detail: {
        toolName: req.toolName,
        summary,
        ...(grant === null ? {} : { [MCP_TOOL_GRANT_DETAIL]: grant }),
        ...editDetail(req, ask),
        ...(req.escalated ? { [ESCALATED_KEY]: true } : {}),
      },
      signal: ctx.signal,
      // An edit's result depends on the file it lands on. Folded with another lane's, both lanes would read the
      // file on the one answer, before either writes, and the second write would match neither record.
      // A Write's content doesn't depend on the file, so Writes still fold.
      foldPerLane: EDIT_FAMILY.has(req.toolName) && req.toolName !== 'Write',
      // A conversation's card goes with its call: Claude Code cancels the call when the turn is stopped.
      ...(ctx.workstreamId === null ? { signal: AbortSignal.any([ctx.signal, req.signal]) } : {}),
      // The escalation is only in the detail, so without this an escalated and an ordinary ask would share a card.
      escalated: req.escalated,
    });
    const result = await waitOrWithdraw(item, answer);
    // inbox.answer has already written any rule this choice implies, in the answer's transaction.
    if (ALLOWING.includes(result.choice)) {
      recordAllowedWrite(item.id, req, ask);
      return { behavior: 'allow' };
    }
    return {
      behavior: 'deny',
      message: denialMessage(req.toolName, summary, result.note),
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
        category: QuestionCategory.Environment,
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
      return { summary: command, body: `${command}\n\n${LOOP_CARD_BODY}`, onceOnly: true };
    }
    if (sandbox.commandsAsk === true) return { summary: command };
    if (hit === null && !req.escalated && unread === null && unreadable === null)
      return { behavior: 'allow' };
    return hit?.name === 'deps' && hit.words[0] === 'pnpm'
      ? { summary: command, body: `${command}\n\n${PNPM_CARD_BODY}` }
      : { summary: command };
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
      return { summary: command };
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
    };
  }

  function judgeEdit(
    req: ToolRequest,
    sandbox: NonNullable<BrokerContext['sandbox']>,
  ): ToolDecision | Ask {
    const path = stringField(req.input, 'file_path') ?? stringField(req.input, 'notebook_path');
    if (path === null) return UNJUDGED_PATH;
    try {
      const { realPath } = writeAccess(path, sandbox.fileAccess);
      return { summary: realPath, realPaths: [realPath] };
    } catch {
      return UNJUDGED_PATH;
    }
  }

  function isDecision(verdict: ToolDecision | Ask): verdict is ToolDecision {
    return 'behavior' in verdict;
  }

  async function decide(req: ToolRequest): Promise<ToolDecision> {
    if (req.toolName === 'AskUserQuestion') return askQuestions(req);
    const { sandbox } = ctx;
    if (sandbox === undefined) return askPermission(req);
    if (req.toolName === NETWORK_TOOL) return judgeHost(req);
    let verdict: ToolDecision | Ask | null = null;
    if (req.toolName === 'Bash') verdict = judgeBash(req, sandbox);
    else if (req.toolName === 'Monitor') verdict = judgeMonitor(req, sandbox);
    else if (READ_FAMILY.has(req.toolName)) verdict = judgeRead(req, sandbox);
    else if (EDIT_FAMILY.has(req.toolName)) verdict = judgeEdit(req, sandbox);
    if (verdict === null) return askPermission(req);
    return isDecision(verdict) ? verdict : askPermission(req, verdict);
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
