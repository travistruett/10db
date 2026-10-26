import {
  PermissionChoice,
  QuestionCategory,
  Urgency,
  type InboxAnswer,
  type InboxItemDto,
  type HazardDef,
  type InboxOption,
  type ProjectId,
  type SessionId,
  type WorkstreamId,
} from '@10db/contracts';
import { listPermissionRules } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import { hazardHit, parseShell, stringField } from '../guard';
import { matchPermissionRule, storableRule } from '../permissions';
import { readAccess, readPathsOf, writeAccess, type FileAccessContext } from '../sandbox';
import type { ToolDecision, ToolRequest } from '../sessions';
import { ParkedError, type InboxService } from './service';

export interface WaitObserver {
  onWaitStart(item: InboxItemDto): void;
  onWaitEnd(item: InboxItemDto): void;
}

interface BrokerContext {
  readonly projectId: ProjectId;
  readonly workstreamId: WorkstreamId;
  readonly sessionId: SessionId;
  readonly observer: WaitObserver;
  readonly signal: AbortSignal;
  /** An `allow_once` answered after the workstream was parked: the first identical call is allowed. */
  readonly allowOnce?: { readonly toolName: string; readonly summary: string } | null;
  /**
   * Present for a sandboxed lane: its commands run without a card unless they are hazards, its
   * unlisted hosts are refused and asked about, and its file tools are judged by real path.
   */
  readonly sandbox?: {
    readonly fileAccess: FileAccessContext;
    readonly hazards: readonly HazardDef[];
  };
}

const ALLOWING: readonly string[] = [
  PermissionChoice.AllowOnce,
  PermissionChoice.AllowWorkstream,
  PermissionChoice.AllowProject,
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

const NETWORK_TOOL = 'SandboxNetworkAccess';
const READ_FAMILY: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS']);
const EDIT_FAMILY: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const HOST_CARD_BODY =
  'The command was refused. Allow the host for the project and the next session gets it; allow once only reaches a session that is still running.';
const PNPM_CARD_BODY =
  "pnpm 12 can't install inside the lane sandbox yet (spike 14 check 9). Approving lets the command run; it will fail on pnpm's store lock. Run it yourself, or use npm.";

const NetworkInput = z.looseObject({ host: z.string().min(1) });

/** What the broker asks about once a sandboxed call needs a person: the card's text and the real paths it names. */
interface Ask {
  readonly summary: string;
  readonly body?: string;
  readonly realPaths?: readonly string[];
}

function summarize(req: ToolRequest): string {
  const command = req.input['command'];
  if (req.toolName === 'Bash' && typeof command === 'string') return command;
  return JSON.stringify(req.input).slice(0, 2000);
}

/** Decides every canUseTool call: stored rules first, then a card for the builder. Never an LLM. */
export function createPermissionBroker(
  deps: { readonly state: StateStore; readonly inbox: InboxService },
  ctx: BrokerContext,
): (req: ToolRequest) => Promise<ToolDecision> {
  let allowOnce = ctx.allowOnce ?? null;

  async function wait(item: InboxItemDto, answer: Promise<InboxAnswer>): Promise<InboxAnswer> {
    ctx.observer.onWaitStart(item);
    const result = await answer;
    ctx.observer.onWaitEnd(item);
    return result;
  }

  async function askQuestions(req: ToolRequest): Promise<ToolDecision> {
    const parsed = AskUserQuestionInput.safeParse(req.input);
    if (!parsed.success) {
      return {
        behavior: 'deny',
        message: 'AskUserQuestion input was not understood; use ask_human instead.',
      };
    }
    const answers: Record<string, string> = {};
    for (const q of parsed.data.questions) {
      const { item, answer } = deps.inbox.ask({
        projectId: ctx.projectId,
        workstreamId: ctx.workstreamId,
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

  async function askPermission(req: ToolRequest, ask: Ask | null = null): Promise<ToolDecision> {
    const rules = listPermissionRules(deps.state.db, ctx.projectId, ctx.workstreamId);
    const paths = ask?.realPaths === undefined ? undefined : { realPaths: ask.realPaths };
    // A call the classifier handed to a person is answered by a person, never by a stored grant.
    if (!req.escalated && matchPermissionRule(req, rules, paths)) return { behavior: 'allow' };
    const summary = ask?.summary ?? summarize(req);
    if (!req.escalated && allowOnce?.toolName === req.toolName && allowOnce.summary === summary) {
      allowOnce = null;
      return { behavior: 'allow' };
    }
    const storable = storableRule(req.toolName, summary) !== undefined;
    const { item, answer } = deps.inbox.ask({
      projectId: ctx.projectId,
      workstreamId: ctx.workstreamId,
      sessionId: ctx.sessionId,
      kind: 'permission',
      title: `Allow ${req.toolName}?`,
      body: ask?.body ?? summary,
      options: permissionOptions(storable),
      recommendation: null,
      category: QuestionCategory.Environment,
      urgency: Urgency.Normal,
      detail: { toolName: req.toolName, summary },
      signal: ctx.signal,
    });
    const result = await wait(item, answer);
    // inbox.answer has already written any rule this choice implies, in the answer's transaction.
    if (ALLOWING.includes(result.choice)) return { behavior: 'allow' };
    return {
      behavior: 'deny',
      message: `The builder denied ${req.toolName}.${result.note ? ` Note: ${result.note}` : ''}`,
    };
  }

  const hostsAsked = new Set<string>();
  const hostsAllowedOnce = new Set<string>();

  /** A host the lane's command reached for: allowed by a rule or a one-time allowance, else refused and asked about once. */
  function judgeHost(req: ToolRequest): ToolDecision {
    const parsed = NetworkInput.safeParse(req.input);
    if (!parsed.success) {
      return {
        behavior: 'deny',
        message: 'The network request named no host, so 10db refused it.',
      };
    }
    const host = parsed.data.host.toLowerCase();
    const rules = listPermissionRules(deps.state.db, ctx.projectId, ctx.workstreamId);
    if (matchPermissionRule({ toolName: NETWORK_TOOL, input: { host } }, rules)) {
      return { behavior: 'allow' };
    }
    if (hostsAllowedOnce.delete(host)) return { behavior: 'allow' };
    if (allowOnce?.toolName === NETWORK_TOOL && allowOnce.summary === host) {
      allowOnce = null;
      return { behavior: 'allow' };
    }
    if (!hostsAsked.has(host)) {
      hostsAsked.add(host);
      const { answer } = deps.inbox.ask({
        projectId: ctx.projectId,
        workstreamId: ctx.workstreamId,
        sessionId: ctx.sessionId,
        kind: 'permission',
        title: `Allow network access to ${host}?`,
        body: HOST_CARD_BODY,
        options: permissionOptions(true).filter(
          (o) => o.label !== PermissionChoice.AllowWorkstream,
        ),
        recommendation: null,
        category: QuestionCategory.Environment,
        urgency: Urgency.Normal,
        detail: { toolName: NETWORK_TOOL, summary: host },
        signal: ctx.signal,
      });
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
    };
  }

  /** A sandboxed Bash command runs without a card unless it is a hazard or the parser cannot read it. */
  function judgeBash(
    req: ToolRequest,
    sandbox: NonNullable<BrokerContext['sandbox']>,
  ): ToolDecision | Ask {
    const command = req.input['command'];
    if (typeof command !== 'string') return { summary: summarize(req) };
    const hit = hazardHit(command, sandbox.hazards);
    if (hit === null && parseShell(command).certain && !req.escalated) return { behavior: 'allow' };
    return hit?.name === 'deps' && hit.words[0] === 'pnpm'
      ? { summary: command, body: `${command}\n\n${PNPM_CARD_BODY}` }
      : { summary: command };
  }

  /** A read tool: protected paths are refused, the checkout and the read list are open, the rest is asked about by real path. */
  function judgeRead(
    req: ToolRequest,
    sandbox: NonNullable<BrokerContext['sandbox']>,
  ): ToolDecision | Ask {
    const inputs = readPathsOf(req.toolName, req.input);
    if (inputs.length === 0) return { summary: summarize(req) };
    const asking: string[] = [];
    try {
      for (const path of inputs) {
        const { access, realPath } = readAccess(path, sandbox.fileAccess, req.toolName !== 'Read');
        if (access === 'protected' || access === 'contains-protected') {
          return {
            behavior: 'deny',
            message: `${path} is a protected path; 10db never lets a lane read it.`,
          };
        }
        if (access === 'ask') asking.push(realPath);
      }
    } catch {
      return { behavior: 'deny', message: `${req.toolName} could not be judged; 10db refuses it.` };
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

  function judgeEdit(req: ToolRequest, sandbox: NonNullable<BrokerContext['sandbox']>): Ask {
    const path = stringField(req.input, 'file_path') ?? stringField(req.input, 'notebook_path');
    if (path === null) return { summary: summarize(req) };
    try {
      const { realPath } = writeAccess(path, sandbox.fileAccess);
      return { summary: realPath, realPaths: [realPath] };
    } catch {
      return { summary: summarize(req) };
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
        return { behavior: 'deny', message: 'Parked until the builder answers.', interrupt: true };
      }
      throw error;
    }
  };
}
