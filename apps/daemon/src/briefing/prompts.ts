import type {
  ClaimKind,
  ContextPack,
  EvidenceDto,
  HandoffDto,
  NextAction,
  TaskDto,
} from '@10db/contracts';

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
}

export const HANDOFF_NUDGE =
  '10db: your context is filling up. Finish the step you are on, commit it, then call the write_handoff tool with the six-part handoff and end your turn. Do not start new work.';

const RULES = [
  'Edit only files inside your claims. For anything else, call the request_claim tool first.',
  'Commit only through the 10db commit tool, naming every path. Never run git commit, add, checkout, reset, stash or push --force.',
  'When a decision is not yours to make, ask with ask_human (or your question tool). Record routine engineering decisions with record_decision.',
  'If you depart from the plan or a principle, call report_deviation with your reason.',
  'When the acceptance criteria are met and committed, end your turn. 10db runs the gate itself.',
  'If 10db asks you to hand off, finish your current step, call write_handoff, and end your turn.',
];

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

function actionSection(input: PromptInput): string {
  switch (input.action.kind) {
    case 'start':
      return 'Begin.';
    case 'continue_from_handoff':
      return input.handoff
        ? `Continue from the handoff below. Do not redo finished work.\n\nHandoff:\n${renderHandoff(input.handoff)}`
        : 'Continue the task; the previous session left no handoff, so inspect git status first.';
    case 'resume':
      return `10db resumed this session after an interruption (${input.recovery?.reason ?? input.action.reason}). Inspect git status before continuing. Last acknowledged 10db operation: ${input.recovery?.lastOp ?? 'none'}. If a tool call may not have completed, retry it with the same opId.`;
    case 'answer':
      return input.answer
        ? `The builder answered your question.\nQuestion: ${input.answer.question}\nAnswer: ${input.answer.answer}${input.answer.note ? `\nNote: ${input.answer.note}` : ''}\nContinue.`
        : 'The builder answered your question; continue.';
    case 'fix':
      return input.evidence
        ? `The gate failed (exit ${String(input.evidence.exitCode)} from \`${input.evidence.command}\`). Fix the cause, commit, and end your turn.\n\nGate output (end):\n\`\`\`\n${input.evidence.summary}\n\`\`\``
        : 'The gate failed. Run it, fix the cause, commit, and end your turn.';
    case 'verify':
      return 'Verify the work against the acceptance criteria, commit anything outstanding, and end your turn.';
  }
}

export function buildSessionPrompt(input: PromptInput): string {
  const claims = input.claims.map((c) => `${c.kind} ${c.name}`).join(', ') || '(none)';
  return [
    'You are working on one task in a shared repository, managed by 10db.',
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
    bullets(RULES),
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
