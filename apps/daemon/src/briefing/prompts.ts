import {
  EvidenceKind,
  REVIEW_ROLES,
  ToolAccess,
  type ClaimKind,
  type ContextPack,
  type EvidenceDto,
  type HandoffDto,
  type NextAction,
  type StepResult,
  type StepRole,
  type TaskDto,
} from '@10db/contracts';

interface StepBrief {
  readonly index: number;
  readonly count: number;
  readonly role: StepRole;
  readonly personaName: string;
  readonly instructions: string | null;
  readonly skills: readonly string[];
  readonly tools: ToolAccess;
}

interface PriorResult {
  readonly role: StepRole;
  readonly personaName: string;
  readonly result: StepResult;
}

export interface PromptInput {
  readonly task: Pick<TaskDto, 'title' | 'description' | 'acceptanceCriteria'>;
  readonly claims: readonly { readonly kind: ClaimKind; readonly name: string }[];
  readonly action: NextAction;
  readonly handoff: HandoffDto | null;
  readonly answer: {
    readonly question: string;
    readonly answer: string;
    readonly note: string | null;
  } | null;
  readonly evidence: EvidenceDto | null;
  readonly recovery: { readonly reason: string; readonly lastOp: string | null } | null;
  readonly contextPack: ContextPack;
  readonly step: StepBrief;
  readonly priorResults: readonly PriorResult[];
  /** A read-only step sent back sees the result it gave before. */
  readonly previousResult: StepResult | null;
  readonly revisedBy: { readonly role: StepRole; readonly personaName: string } | null;
  /** The session runs in the lane sandbox, which loads no repo settings and blocks paths outside its profile. */
  readonly sandboxed?: boolean;
}

export const HANDOFF_NUDGE =
  '10db: your context is filling up. Finish the step you are on, commit it, then call the write_handoff tool with the six-part handoff and end your turn. Do not start new work.';

export const HANDOFF_FIRM_NUDGE =
  '10db: your context is almost full. Call write_handoff now and end your turn.';

/** The handoff nudge for a read-only step, which has nothing to commit. */
export const HANDOFF_NUDGE_READ_ONLY =
  '10db: your context is filling up. Call mcp__10db__write_handoff with what you have found so far and end your turn. Do not start new checks.';

export const HANDOFF_NUDGE_ACCOUNT =
  '10db: this account is near its usage limit and the project is moving to another one. The next session starts from your handoff, not this conversation, so finish the step you are on, commit everything, then call the write_handoff tool with the six-part handoff and end your turn. Do not start new work.';

/** The account nudge for a read-only step, which has nothing to commit. */
export const HANDOFF_NUDGE_ACCOUNT_READ_ONLY =
  '10db: this account is near its usage limit and the project is moving to another one. The next session starts from your handoff, not this conversation, so call mcp__10db__write_handoff with what you have found so far and end your turn. Do not start new checks.';

export const HANDOFF_FIRM_NUDGE_ACCOUNT =
  '10db: this account is about to reach its usage limit. Call write_handoff now and end your turn.';

/** Sent when a read-only step ends its turn without recording its result in this session. */
export const RESULT_NUDGE =
  '10db: this step is not finished until you call mcp__10db__complete_step with your result (and, for a review, a verdict). Call it now, then end your turn.';

const PLAIN_COMMANDS =
  "Run project commands in their plain form: `pnpm exec <tool> …` or the project's own scripts, with no `-s` or `--silent`, no trailing `; echo $?` (the exit code is reported to you), no `timeout` wrapper, and no piping test output through head or tail.";

/** Beside the plain-commands line in a sandboxed session. */
const SANDBOX_RULES = [
  "Read the repository's agent instructions first: `AGENTS.md`, or `CLAUDE.md` where the repo uses it.",
  'Make temp files with `mktemp "$TMPDIR/x.XXXXXX"`; a bare `mktemp` fails in the sandbox.',
  "A command that fails with `Operation not permitted` hit the sandbox: say which path in your handoff, and don't retry it another way.",
];

const RULES = [
  'Edit only files inside your claims. For anything else, call the request_claim tool first. When another task holds the claim, the call waits until it frees; do not edit those files without it.',
  'Commit only through the 10db commit tool, naming every path. Never run git commit, add, checkout, reset, stash or push: 10db pushes the work when it ships, and the git dir is read-only to you.',
  'Before you end your turn, commit every change in your claims through mcp__10db__commit. A step that ends with changes uncommitted is sent back to you, and no gate runs on it.',
  'When a decision is not yours to make, ask with ask_human (or your question tool). Record routine engineering decisions with record_decision.',
  'If you depart from the plan or a principle, call report_deviation with your reason.',
  PLAIN_COMMANDS,
  'When the acceptance criteria are met and committed, end your turn. 10db runs the gate itself.',
  'If 10db asks you to hand off, finish your current step, call write_handoff, and end your turn.',
];

function readOnlyRules(role: StepRole): string[] {
  return [
    'This step is read-only: 10db refuses file edits, commits and any shell command that writes. Report what should change; the implement step changes it.',
    'When a decision is not yours to make, ask with mcp__10db__ask_human (or your question tool). Record routine engineering decisions with mcp__10db__record_decision.',
    REVIEW_ROLES.includes(role)
      ? 'When you are done, call mcp__10db__complete_step with your findings and a verdict (approve or reject), then end your turn.'
      : 'When you are done, call mcp__10db__complete_step with your plan, then end your turn.',
    PLAIN_COMMANDS,
    'If 10db asks you to hand off, call mcp__10db__write_handoff, and end your turn.',
  ];
}

/** The rules with the sandbox's lines after the plain-commands line, when the session is sandboxed. */
function withSandboxRules(rules: readonly string[], sandboxed: boolean): string[] {
  if (!sandboxed) return [...rules];
  return rules.flatMap((rule) => (rule === PLAIN_COMMANDS ? [rule, ...SANDBOX_RULES] : [rule]));
}

const VERDICT_LABEL = { approve: 'approved', reject: 'rejected' } as const;

const bullets = (lines: readonly string[]) =>
  lines.length === 0 ? '- (none)' : lines.map((l) => `- ${l}`).join('\n');

export function renderHandoff(h: HandoffDto): string {
  const c = h.content;
  return [
    `Objective: ${c.objective.task}`,
    `Non-goals:\n${bullets(c.objective.nonGoals)}`,
    `Done:\n${bullets(c.progress.done)}`,
    `Not done:\n${bullets(c.progress.notDone)}`,
    `Next action: ${c.progress.nextAction}`,
    `Changed files (from git): ${h.gitChangedFiles.join(', ') || '(none)'}`,
    `Commits (from git): ${h.gitCommits.join(', ') || '(none)'}`,
    `Uncommitted: ${c.codeState.uncommittedSummary || '(none)'}`,
    `Decisions:\n${bullets(c.reasoning.decisions)}`,
    `Trade-offs:\n${bullets(c.reasoning.tradeOffs)}`,
    `Rejected approaches:\n${bullets(c.reasoning.rejected)}`,
    `Checks:\n${bullets(c.validation.checks.map((k) => `${k.command}: ${k.result}`))}`,
    `Environment problems:\n${bullets(c.validation.environmentProblems)}`,
    `Blockers:\n${bullets(c.continuity.blockers)}`,
    `Pending questions:\n${bullets(c.continuity.pendingQuestions)}`,
    `Background jobs:\n${bullets(c.continuity.backgroundJobs)}`,
    `Notes: ${c.continuity.notes || '(none)'}`,
  ].join('\n');
}

function renderKnowledge(pack: ContextPack): string {
  const { decisions, droppedCount, empty } = pack.knowledge;
  if (empty && droppedCount > 0) {
    return `${String(droppedCount)} recorded decisions exceeded the budget and are not shown; call get_context or find_knowledge for them.`;
  }
  if (empty)
    return 'No recorded decisions apply to this task yet. Call get_context to refresh later.';
  const lines = decisions.map((d) => `${d.question} -> ${d.choice} (${d.rationale})`);
  const omitted =
    droppedCount > 0
      ? `\n${String(droppedCount)} more omitted; call get_context or find_knowledge for them.`
      : '';
  return `Recorded decisions:\n${bullets(lines)}${omitted}`;
}

/**
 * Whether a fresh session starts from the step's latest handoff: a continuation, an answer with no
 * conversation to resume, and a fix whose handoff was written after its gate failed, which is a fix
 * session that was cut off, by a move to another account for one.
 */
export function briefedFromHandoff(
  action: NextAction,
  handoff: HandoffDto | null,
  evidence: EvidenceDto | null,
): boolean {
  if (handoff === null) return false;
  switch (action.kind) {
    case 'continue_from_handoff':
      return true;
    case 'answer':
      return action.providerSessionId === null;
    case 'fix':
      return evidence !== null && handoff.createdAt > evidence.createdAt;
    case 'start':
    case 'resume':
    case 'uncommitted':
    case 'verify':
    case 'revise':
    case 'builder_review':
      return false;
  }
}

const fromHandoff = (handoff: HandoffDto): string =>
  `Continue from the handoff below. Do not redo finished work.\n\nHandoff:\n${renderHandoff(handoff)}`;

const gateFailure = (evidence: EvidenceDto): string =>
  evidence.kind === EvidenceKind.Builder
    ? `The builder sent the work back: ${evidence.summary}\nAddress it, commit, and end your turn.`
    : `The gate failed (exit ${String(evidence.exitCode)} from \`${evidence.command}\`). Fix the cause, commit, and end your turn.\n\nGate output (end):\n\`\`\`\n${evidence.summary}\n\`\`\``;

function actionSection(input: PromptInput): string {
  switch (input.action.kind) {
    case 'start':
      return 'Begin.';
    case 'continue_from_handoff':
      return input.handoff
        ? fromHandoff(input.handoff)
        : 'Continue the task; the previous session left no handoff, so inspect git status first.';
    case 'resume':
      return `10db resumed this session after an interruption (${input.recovery?.reason ?? input.action.reason}). Inspect git status before continuing. Last acknowledged 10db operation: ${input.recovery?.lastOp ?? 'none'}. If a tool call may not have completed, retry it with the same opId.`;
    case 'answer': {
      const answer = input.answer
        ? `The builder answered your question.\nQuestion: ${input.answer.question}\nAnswer: ${input.answer.answer}${input.answer.note ? `\nNote: ${input.answer.note}` : ''}\nContinue.`
        : 'The builder answered your question; continue.';
      if (input.action.providerSessionId !== null) return answer;
      // No conversation to resume: the session starts from the handoff, as a continuation would,
      // and still sees a gate failure it was fixing.
      const brief =
        input.handoff && briefedFromHandoff(input.action, input.handoff, input.evidence)
          ? fromHandoff(input.handoff)
          : 'The previous session left no handoff, so inspect git status first.';
      return [brief, ...(input.evidence ? [gateFailure(input.evidence)] : []), answer].join('\n\n');
    }
    case 'fix': {
      const gate = input.evidence
        ? gateFailure(input.evidence)
        : 'The gate failed. Run it, fix the cause, commit, and end your turn.';
      // A fix session that was cut off left a handoff after the failure; the next one starts from it.
      return input.handoff && briefedFromHandoff(input.action, input.handoff, input.evidence)
        ? `${fromHandoff(input.handoff)}\n\n${gate}`
        : gate;
    }
    case 'uncommitted':
      return `Your step ended with changes in your claims that are not committed:\n${bullets(input.action.paths)}\nCommit each one through mcp__10db__commit, naming every path, then end your turn. 10db runs the gate once they are committed.`;
    case 'verify':
      return 'Verify the work against the acceptance criteria, commit anything outstanding, and end your turn.';
    case 'builder_review':
      return 'The builder is checking the work; there is nothing to do until they answer.';
    case 'revise': {
      const by = input.revisedBy
        ? `The ${input.revisedBy.role} step (${input.revisedBy.personaName})`
        : 'A reviewer';
      return input.step.tools === ToolAccess.Edit
        ? `${by} rejected the work. Its notes are under Earlier steps. Address each one, commit, and end your turn.`
        : `${by} rejected your result. Its notes are under Earlier steps. Address each one, then call mcp__10db__complete_step again.`;
    }
  }
}

function stepSection(input: PromptInput): string[] {
  const { step } = input;
  const lines = [
    `Your step: ${String(step.index + 1)} of ${String(step.count)}, ${step.role}, as ${step.personaName}.`,
  ];
  if (step.skills.length > 0) lines.push(`Skills to use: ${step.skills.join(', ')}.`);
  if (step.instructions) lines.push('', `How you work:\n${step.instructions}`);
  if (input.priorResults.length > 0) {
    lines.push('', 'Earlier steps:');
    for (const prior of input.priorResults) {
      const verdict = prior.result.verdict ? `: ${VERDICT_LABEL[prior.result.verdict]}` : '';
      lines.push(`--- ${prior.role} (${prior.personaName})${verdict}`, prior.result.summary, '---');
    }
  }
  if (input.previousResult) {
    const verdict = input.previousResult.verdict
      ? `: ${VERDICT_LABEL[input.previousResult.verdict]}`
      : '';
    lines.push('', `Your previous result${verdict}:`, input.previousResult.summary);
  }
  return lines;
}

export function buildSessionPrompt(input: PromptInput): string {
  const claims = input.claims.map((c) => `${c.kind} ${c.name}`).join(', ') || '(none)';
  return [
    'You are working on one task in a shared repository, managed by 10db.',
    '',
    ...stepSection(input),
    '',
    `Task: ${input.task.title}`,
    input.task.description,
    '',
    'Acceptance criteria:',
    bullets(input.task.acceptanceCriteria),
    '',
    `Your claims: ${claims}.`,
    '',
    'Rules:',
    bullets(
      withSandboxRules(
        input.step.tools === ToolAccess.ReadOnly ? readOnlyRules(input.step.role) : RULES,
        input.sandboxed === true,
      ),
    ),
    '',
    'Context pack:',
    renderKnowledge(input.contextPack),
    '',
    actionSection(input),
  ].join('\n');
}

export function compactionReinjection(pack: ContextPack): string {
  return `10db: your conversation was compacted. Here is your context pack again:\n${JSON.stringify(pack, null, 2)}`;
}
