import {
  PermissionChoice,
  QuestionCategory,
  Urgency,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type ProjectId,
  type SessionId,
  type WorkstreamId,
} from '@10db/contracts';
import { listPermissionRules } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import { commandPrefix, matchPermissionRule } from '../permissions';
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

  async function askPermission(req: ToolRequest): Promise<ToolDecision> {
    const rules = listPermissionRules(deps.state.db, ctx.projectId, ctx.workstreamId);
    if (matchPermissionRule(req, rules)) return { behavior: 'allow' };
    const summary = summarize(req);
    if (allowOnce?.toolName === req.toolName && allowOnce.summary === summary) {
      allowOnce = null;
      return { behavior: 'allow' };
    }
    const storable = req.toolName !== 'Bash' || commandPrefix(summary) !== null;
    const { item, answer } = deps.inbox.ask({
      projectId: ctx.projectId,
      workstreamId: ctx.workstreamId,
      sessionId: ctx.sessionId,
      kind: 'permission',
      title: `Allow ${req.toolName}?`,
      body: summary,
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

  return async (req) => {
    try {
      return req.toolName === 'AskUserQuestion'
        ? await askQuestions(req)
        : await askPermission(req);
    } catch (error) {
      if (error instanceof ParkedError) {
        return { behavior: 'deny', message: 'Parked until the builder answers.', interrupt: true };
      }
      throw error;
    }
  };
}
