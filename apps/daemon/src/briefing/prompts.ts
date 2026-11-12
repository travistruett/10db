import {
  findingNotes,
  REVIEW_ROLES,
  ToolAccess,
  type ClaimKind,
  type ContextPack,
  type EvidenceDto,
  type HandoffDto,
  type NextAction,
  Provider,
  type StepResult,
  StepRole,
  type TaskDto,
  Verdict,
} from '@10db/contracts';
import { renderDecisions, renderRules } from '../knowledge';
import { isOutsideCopy } from '../sandbox';
import { failedSteps } from './failed-steps';

interface StepBrief {
  readonly index: number;
  readonly count: number;
  readonly role: StepRole;
  readonly personaName: string;
  readonly instructions: string | null;
  readonly skills: readonly string[];
  /** The text of each skill, for a session that has no plugin to load them from. */
  readonly skillBodies?: readonly string[];
  readonly tools: ToolAccess;
}

interface PriorResult {
  readonly role: StepRole;
  readonly personaName: string;
  readonly result: StepResult;
}

export interface PromptInput {
  /** The agent the account this session runs on uses; never the project's, which can move between accounts. */
  readonly provider: Provider;
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
  /** The results this step gave on earlier rounds (a review's rejections), oldest first. */
  readonly earlierResults: readonly StepResult[];
  readonly revisedBy: { readonly role: StepRole; readonly personaName: string } | null;
  /** The session runs in the lane sandbox, which loads no repo settings and blocks paths outside its profile. */
  readonly sandboxed?: boolean;
  /** Calls the builder denied for this workstream, in any of its sessions; every session is told. */
  readonly denials?: readonly Denial[];
  /**
   * The Inbox cards the builder already answered on this task, oldest first. Only a review step is
   * shown them, so it checks a decision against them instead of asking the builder again.
   */
  readonly answeredCards?: readonly AnsweredCard[];
  /** What the batch's notice says of migrations a merge of its base renumbered, when any were. */
  readonly renumbered?: string | null;
  /** What the batch's notice says of migrations a merge of its base lost, while any are missing. */
  readonly uncarried?: string | null;
  /**
   * The session works on one page of a Workbench pass: a turn ends at the change on screen, and the
   * builder writes again, so the step's rules for ending, committing and the gate do not apply.
   */
  readonly inPass?: boolean;
  /**
   * 10db takes pictures of the task's pages for the builder (Workbench spec §10): a pass page, or a
   * task in Your folder naming a routed page, on a project with an app address.
   */
  readonly pictures?: boolean;
  /**
   * For a `feedback` action: the builder's message as the session reads it, and the thread's digest a
   * session with no conversation to resume starts from (null for one that resumes it).
   */
  readonly feedback?: { readonly message: string; readonly digest: string | null };
  /**
   * The repository's and the builder's instructions came in the system prompt, so a sandboxed session is
   * told they are there instead of to read them.
   */
  readonly instructionsLoaded?: boolean;
  /** What the session's setup brought along and left out, as one rule line, beside the instructions line. */
  readonly setupLine?: string | null;
  /** Claude Code's auto mode judges the lane's WebSearch and WebFetch, so they wait on no card. */
  readonly webJudged?: boolean;
}

/** An Inbox card the builder answered, as a reviewer is shown it. */
export interface AnsweredCard {
  readonly id: string;
  readonly kind: string;
  readonly question: string;
  readonly choice: string;
  readonly note: string | null;
}

/**
 * What a review step is told of the cards the builder already answered on its task: each with its
 * id, question, choice and note. A decision one of them covers is not asked again; a decision none
 * covers is still the reviewer's to raise. Empty for any other step, and when there are none.
 */
function renderAnsweredCards(role: StepRole, cards: readonly AnsweredCard[] = []): string[] {
  if (cards.length === 0 || !REVIEW_ROLES.includes(role)) return [];
  const lines = cards.map(
    (c) =>
      `- ${c.id} (${c.kind}): ${c.question} -> ${c.choice}${c.note ? ` (note: ${c.note})` : ''}`,
  );
  return [
    '',
    'Inbox cards the builder already answered on this task:',
    ...lines,
    'Check a decision you are about to raise against these. When an answer here covers it (an acceptance criterion shipped unmeasured, an option chosen), the builder has decided: cite the card id, do not raise a card asking again, and do not reject for what the answer accepted. When no answer here covers it, raise the card as usual.',
  ];
}

/** A call the builder denied, and the note they gave. */
export interface Denial {
  readonly toolName: string;
  readonly summary: string;
  readonly note: string | null;
}

/** The tools whose denial's summary is the real path they asked for. */
const PATH_DENIALS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS']);

/**
 * The denials a lane is told about. A read denied before such a path was refused with no card names a
 * path outside the lane's copy, and repeating that path to the lane would hand it the wrong root.
 */
export function denialsForLane<D extends Denial>(
  denials: readonly D[],
  scope: { readonly checkout: string; readonly worktreeRoot: string },
): D[] {
  return denials.filter((d) => !(PATH_DENIALS.has(d.toolName) && isOutsideCopy(d.summary, scope)));
}

/** The longest call or note a prompt repeats; a denial is a pointer, not a transcript. */
const MAX_DENIAL_CHARS = 400;

const clip = (text: string): string =>
  text.length > MAX_DENIAL_CHARS ? `${text.slice(0, MAX_DENIAL_CHARS)}…` : text;

/**
 * What the builder denied in this workstream, in words that cover equivalents. Empty when nothing
 * was denied. A denial is the builder's answer for the whole workstream, so a new session, a resumed
 * one and a compacted one all see it.
 */
function renderDenials(denials: readonly Denial[]): string[] {
  if (denials.length === 0) return [];
  const lines = denials.map(
    (d) =>
      `${d.toolName}: ${clip(d.summary)}${d.note ? `\n  Note from the builder: ${clip(d.note)}` : ''}`,
  );
  return [
    'The builder denied these calls in this workstream. Each denial covers any equivalent: the same effect written another way (another program, a loop, a script, a wrapper or a different tool) is denied too. Do not run them or equivalents; work without them, or ask with ask_human.',
    bullets(lines),
  ];
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

/**
 * Sent when the commands a session left running in the background have finished after it ended its
 * turn: the session does not learn of that by itself, and 10db has held the step open for it.
 */
export const BACKGROUND_DONE_NUDGE =
  '10db: the command you started in the background has finished. Read its output, finish the step and commit every change in your claims through mcp__10db__commit, then end your turn.';

/** The background nudge for a read-only step, which cannot commit: it records its result instead. */
export const BACKGROUND_DONE_NUDGE_READ_ONLY =
  '10db: the command you started in the background has finished. Read its output, finish the step and call mcp__10db__complete_step with your result (and, for a review, a verdict), then end your turn.';

const COMMAND_SHAPES =
  'Use no shell variables or arrays to hold the paths, no `cd` into the worktree (you are already in it), no `;`, `&&` or `$(…)` chains, and no pipes through tail or grep.';

const COMMAND_SHAPE = `${COMMAND_SHAPES} A command built that way has no rule 10db can store, so it stops on an "Allow Bash?" card and waits for a person, which overnight can be hours.`;

/** A Codex lane gets no "Allow Bash?" card, so its reason is the guard's reading. */
const CODEX_COMMAND_SHAPE = `${COMMAND_SHAPES} 10db's guard checks each command before it runs, and can't read one built that way.`;

const plainCommands = (shape: string): string =>
  `Run project commands in their plain form: \`pnpm exec <tool> …\` or the project's own scripts, with no \`-s\` or \`--silent\`, no trailing \`; echo $?\` (the exit code is reported to you), no \`timeout\` wrapper, and no piping test output through head or tail. Run formatters, linters and test commands each as its own command naming its paths, from your working directory: \`pnpm exec prettier --write path/a.ts path/b.ts\`, then \`pnpm exec eslint path/a.ts path/b.ts\`. ${shape}`;

const PLAIN_COMMANDS = plainCommands(COMMAND_SHAPE);

/**
 * readOnlyShellRefusal denies anything outside READ_COMMANDS and read-only git, so pnpm and every
 * check run through it are refused however they are spelled. Each backticked command here must
 * pass that hook; briefing.test.ts checks every one.
 */
const readOnlyCommands = (shape: string): string =>
  `The shell takes read-only commands only, so do not run pnpm, a formatter, a linter or a test: the hook refuses them. Formatting, lint and tests are left to the gate. Run each command on its own, naming its paths, from your working directory: \`grep -n name path/a.ts path/b.ts\`, then \`git log -p -- path/a.ts path/b.ts\`. ${shape}`;

const READ_ONLY_COMMANDS = readOnlyCommands(COMMAND_SHAPE);

/**
 * Ending the turn ends the step, and a background command (the Bash tool moves a long one there)
 * does not wake a session that has ended its turn. A lane once ended its turn "to wait" for a test
 * run and was failed for the changes it had not committed.
 */
const BACKGROUND_COMMANDS =
  'Run a test or any other command in the foreground and wait for its result. A command moved to the background will not wake you by itself, and ending your turn ends the step: whatever you have not committed by then is left uncommitted. Do not end your turn to wait for one. If a background command is still running when you end your turn, 10db keeps the session open and tells you when it finishes, and fails the step naming the command if it never does.';

/** A read-only step runs no tests and has nothing to commit. */
const BACKGROUND_COMMANDS_READ_ONLY =
  'Run every command in the foreground and wait for its result. A command moved to the background will not wake you by itself, and ending your turn ends the step. Do not end your turn to wait for one. If a background command is still running when you end your turn, 10db keeps the session open and tells you when it finishes, and fails the step naming the command if it never does.';

/** The read-only hook refuses mktemp, so a read-only step does not get this line. */
const TEMP_FILES_RULE =
  'Make temp files with `mktemp "$TMPDIR/x.XXXXXX"`; a bare `mktemp` fails in the sandbox.';

const AUTO_MODE_REFUSES =
  "Claude Code's auto mode refuses three things without saying which rule applied: running the full gate (10db runs it after your turn), generating CPU load on the builder's Mac, and reading or writing outside this lane's worktree. Don't retry a refused call another way.";

const AUTO_MODE_RULE = `${AUTO_MODE_REFUSES} A dependency change, a loop with no end in the background, WebFetch, WebSearch and repo MCP tools wait on a card from the builder.`;

/** The auto-mode line where auto mode judges the web (`PromptInput.webJudged`). */
const AUTO_MODE_WEB_RULE = `${AUTO_MODE_REFUSES} A dependency change, a loop with no end in the background and repo MCP tools wait on a card from the builder. WebSearch and WebFetch go to auto mode's judge, which refuses a fetch that would send the project's code or secrets out; if auto mode isn't running for your model, they wait on a card.`;

const CLAUDE_HOSTS_RULE =
  "A command that reaches a network host outside the project's allowed domains is refused, with no prompt. If you need one, ask the builder with AskUserQuestion.";

const READ_INSTRUCTIONS_RULE =
  "Read the repository's agent instructions first: `AGENTS.md`, or `CLAUDE.md` where the repo uses it.";

const INSTRUCTIONS_LOADED_RULE =
  "The repository's agent instructions (AGENTS.md, CLAUDE.md, .claude/rules) and the builder's own are in your system prompt.";

/** Beside the commands line in a sandboxed session. */
const SANDBOX_RULES = [
  READ_INSTRUCTIONS_RULE,
  TEMP_FILES_RULE,
  "A command that fails with `Operation not permitted` hit the sandbox: say which path in your handoff, and don't retry it another way.",
  AUTO_MODE_RULE,
  CLAUDE_HOSTS_RULE,
];

/** Codex has no auto mode, and a command it cannot run loses its output instead of stopping on a prompt. */
const CODEX_HOSTS_RULE =
  "A command that reaches a network host outside the project's allowed domains fails with its output lost. If you need one, ask with `mcp__10db__ask_human`. The builder adds a host in Settings, which applies from your next session.";

const EDIT_RULE_WAYS =
  ' (`python3 -c`, `node -e`, `perl -pi`, `sed -i`) or shell redirection (`>`, `>>`, a heredoc, `tee`).';

const EDIT_RULE = `Change files with the Edit or Write tool, never with an interpreter one-liner${EDIT_RULE_WAYS} Edit and Write change the file in your lane without a permission card; a Bash command that writes a file stops on an "Allow Bash?" card and waits for a person, which overnight can be hours. Do a multi-line replacement with one Edit call.`;

/**
 * A Codex lane changes files with apply_patch, and gets no permission card either way: the guard
 * judges each path a patch names against the claims, and a command that writes a file names none.
 */
const CODEX_EDIT_RULE = `Change files with apply_patch, never with an interpreter one-liner${EDIT_RULE_WAYS} apply_patch names each file it changes, so 10db checks each one against your claims before it is written; a command that writes a file names none. Do a multi-line replacement with one apply_patch call.`;

const HAND_OFF_RULE =
  'If 10db asks you to hand off, finish your current step, call write_handoff, and end your turn.';

/** A Codex model that has finished its work reaches for write_handoff as a way to say so. */
const CODEX_HAND_OFF_RULE =
  'Ending your turn is how you finish a step: when the work is done and committed, end your turn without calling write_handoff. Never call write_handoff to finish a step. Call it only when 10db asks you to hand off, or when you must stop with work left, which you name under progress.notDone; then finish your current step, call write_handoff, and end your turn.';

/** The lines a Codex lane reads in its own words, by the line Claude's briefing has. */
const CODEX_RULES: ReadonlyMap<string, string> = new Map([
  [EDIT_RULE, CODEX_EDIT_RULE],
  [HAND_OFF_RULE, CODEX_HAND_OFF_RULE],
  [PLAIN_COMMANDS, plainCommands(CODEX_COMMAND_SHAPE)],
  [READ_ONLY_COMMANDS, readOnlyCommands(CODEX_COMMAND_SHAPE)],
]);

/** A skill, a persona or a tool result written for Claude names these tools. */
const CODEX_TOOL_NAMES = 'In this session, the Edit or Write tool means apply_patch.';

const RULES = [
  'Edit only files inside your claims. For anything else, call the request_claim tool first. When another task holds the claim, the call waits until it frees; if it answers waiting: true, call it again with the same opId. Do not edit those files without it.',
  'Commit only through the 10db commit tool, naming every path. Never run git commit, add, checkout, reset, stash or push: 10db pushes the work when it ships, and the git dir is read-only to you.',
  'To add or change a dependency, edit the package.json with an exact version (no ^, ~ or range), then call install_dependencies: 10db resolves it, writes pnpm-lock.yaml and installs, outside your sandbox. Never run pnpm add or pnpm install yourself, which your sandbox cannot do and which can leave the copy’s node_modules broken. Commit the manifests and the lockfile afterwards.',
  'Before you end your turn, commit every change in your claims through mcp__10db__commit. A step that ends with changes uncommitted is sent back to you, and no gate runs on it.',
  'When a decision is not yours to make, ask with ask_human (or your question tool). Record routine engineering decisions with record_decision.',
  'If you depart from the plan or a principle, call report_deviation with your reason.',
  PLAIN_COMMANDS,
  BACKGROUND_COMMANDS,
  // In the brief as well as the persona: a builder's edited persona is never overwritten.
  EDIT_RULE,
  "Run only the checks for what you changed (the changed packages' tests, typecheck and lint), never the full gate: 10db runs it after your turn ends.",
  // In the brief as well as the persona: a builder's edited persona is never overwritten.
  'A task is about one pull request, design and docs included. When a design or docs change would grow past about 300 lines, stop at a coherent point so what you have stands on its own, and file each remaining section with mcp__10db__file_follow_up (one call each, a new opId): 10db parks it in the Icebox column and names this task in its description.',
  'When the acceptance criteria are met and committed, end your turn.',
  HAND_OFF_RULE,
];

/**
 * A pass lane's rules (Workbench spec §6.2). Its turns run in the builder's own folder while the
 * builder's dev server shows each change: 10db keeps the page's work when a turn ends, and the
 * builder answers each turn with another message, so nothing here ends a step.
 */
const PASS_RULES = [
  'Work inside your page: edit only files inside your claims. Shared code needs the request_claim tool first. When another task holds the claim, the call waits until it frees; if it answers waiting: true, call it again with the same opId. Do not edit those files without it.',
  "Never run git commit, add, checkout, reset, stash or push, and never switch the folder's branch: 10db keeps your page's work when your turn ends.",
  'To add or change a dependency, edit the package.json with an exact version (no ^, ~ or range), then call install_dependencies: 10db resolves it, writes pnpm-lock.yaml and installs. Never run pnpm add or pnpm install yourself.',
  'When a decision is not yours to make, ask with ask_human (or your question tool). Record routine engineering decisions with record_decision.',
  PLAIN_COMMANDS,
  'Run each command in the foreground and wait for its result: a command moved to the background will not wake you. One still running when you end your turn goes on until the session ends.',
  EDIT_RULE,
  "Do not run the gate, and do not start, stop or restart a dev server: the builder's own dev server shows each change as you write it. Run a check of your own only for what you changed.",
  'Stop when the change is on screen: end your turn and say in two lines what you changed. The builder looks at the page and writes to you again.',
  "The builder's messages each carry an id, and 10db may send one again: the same id is the same message, so act on it once.",
  HAND_OFF_RULE,
];

/** Told to a session whose pages 10db pictures for the builder (Workbench spec §10 "Which pages"). */
const PICTURES_RULE =
  "10db takes pictures of your task's pages for the builder, by their routes. When a page you changed has no route of its own here (a route with a parameter, or a change only in shared code), name it with report_pages: a page area's route with its parameter filled in, such as /people/42 for /people/[id]. Any other path is refused; at most four routes a turn.";

function readOnlyRules(role: StepRole): string[] {
  return [
    'This step is read-only: 10db refuses file edits, commits and any shell command that writes. Report what should change; the implement step changes it.',
    'When a decision is not yours to make, ask with mcp__10db__ask_human (or your question tool). Record routine engineering decisions with mcp__10db__record_decision.',
    REVIEW_ROLES.includes(role)
      ? 'When you are done, call mcp__10db__complete_step with your findings and a verdict (approve or reject), then end your turn.'
      : 'When you are done, call mcp__10db__complete_step with your plan, then end your turn.',
    ...(role === StepRole.Plan
      ? [
          'A task is about one pull request (about 300 changed lines), design and docs included. If a design or docs plan would grow past that, plan the part that stands alone and list the sections left out by name, one per decision, as follow-up tasks for the implementer to file.',
        ]
      : []),
    READ_ONLY_COMMANDS,
    BACKGROUND_COMMANDS_READ_ONLY,
    'If 10db asks you to hand off, call mcp__10db__write_handoff, and end your turn.',
  ];
}

/** What the session's setup changes of the sandbox's lines. */
interface SetupLines {
  readonly instructionsLoaded: boolean;
  readonly setupLine: string | null;
  readonly webJudged: boolean;
}

/** The sandbox's lines with the instructions line as the setup has it, and the setup line after it. */
function withSetupLines(lines: readonly string[], setup: SetupLines): string[] {
  return lines.flatMap((line) => {
    if (line === AUTO_MODE_RULE) return [setup.webJudged ? AUTO_MODE_WEB_RULE : line];
    if (line !== READ_INSTRUCTIONS_RULE) return [line];
    return [
      setup.instructionsLoaded ? INSTRUCTIONS_LOADED_RULE : line,
      ...(setup.setupLine ? [setup.setupLine] : []),
    ];
  });
}

/** The sandbox's lines as the agent the session runs under needs them. */
function sandboxRulesFor(provider: Provider, setup: SetupLines): readonly string[] {
  switch (provider) {
    case Provider.Claude:
      return withSetupLines(SANDBOX_RULES, setup);
    case Provider.Codex:
      return withSetupLines(
        SANDBOX_RULES.filter((line) => line !== AUTO_MODE_RULE).map((line) =>
          line === CLAUDE_HOSTS_RULE ? CODEX_HOSTS_RULE : line,
        ),
        setup,
      );
  }
}

/** A rule as the agent the session runs under reads it: Codex's tools and cards in its own words. */
function ruleFor(provider: Provider, rule: string): string {
  switch (provider) {
    case Provider.Claude:
      return rule;
    case Provider.Codex:
      return CODEX_RULES.get(rule) ?? rule;
  }
}

/** The rules with the sandbox's lines after the commands line, when the session is sandboxed. */
function withSandboxRules(
  rules: readonly string[],
  sandboxed: boolean,
  provider: Provider,
  setup: SetupLines,
): string[] {
  const sandbox = sandboxed ? sandboxRulesFor(provider, setup) : [];
  return rules.flatMap((rule) => {
    const own = ruleFor(provider, rule);
    if (rule === PLAIN_COMMANDS) return [own, ...sandbox];
    if (rule === READ_ONLY_COMMANDS) {
      return [own, ...sandbox.filter((line) => line !== TEMP_FILES_RULE)];
    }
    return [own];
  });
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

/**
 * The knowledge in the pack as rules a session can cite (spec §9): policies, heuristics, then the
 * decisions for the task, each with its id and scope; what the budget left out is counted per shelf.
 * The bootstrap prompt and the post-compaction re-injection both use it, so they read the same.
 */
function renderKnowledge(pack: ContextPack): string {
  const k = pack.knowledge;
  const omitted =
    k.droppedCount > 0
      ? `${String(k.droppedCount)} records exceeded the budget (policies: ${String(k.dropped.policies)}, heuristics: ${String(k.dropped.heuristics)}, decisions: ${String(k.dropped.decisions)}); call find_knowledge for them.`
      : null;
  if (k.empty)
    return (
      omitted ??
      'No recorded decisions or principles apply to this task yet. Call find_knowledge if you need one.'
    );
  return [...renderRules(k), ...renderDecisions(k.decisions), ...(omitted ? [omitted] : [])].join(
    '\n',
  );
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
    case 'feedback':
      return action.providerSessionId === null;
    case 'fix':
      return evidence !== null && handoff.createdAt > evidence.createdAt;
    case 'start':
    case 'resume':
    case 'uncommitted':
    case 'merge':
    case 'verify':
    case 'revise':
    case 'builder_review':
    case 'pass_review':
      return false;
  }
}

const fromHandoff = (handoff: HandoffDto): string =>
  `Continue from the handoff below. Do not redo finished work.\n\nHandoff:\n${renderHandoff(handoff)}`;

/** Where to look after a failed gate: each failing step and the command that reruns it, when the output names them. */
function failedStepsSection(output: string): string {
  const steps = failedSteps(output);
  if (steps.length === 0)
    return 'Its output below says which check failed: rerun only the check that failed while you fix it.';
  const lines = steps.map((s) => `\`${s.name}\`: rerun \`${s.command}\` (log \`${s.log}\`)`);
  return `Failing steps; rerun only these while you fix them:\n${bullets(lines)}`;
}

/** A read-only step (one a retry restarted with the builder's note) has nothing to commit. */
const gateFailure = (evidence: EvidenceDto, tools: ToolAccess): string =>
  evidence.command === null
    ? `The builder sent the work back: ${evidence.summary}\n${
        tools === ToolAccess.Edit
          ? 'Address it, commit, and end your turn.'
          : 'Take it into account, then call mcp__10db__complete_step.'
      }`
    : `The gate failed (exit ${String(evidence.exitCode)} from \`${evidence.command}\`).\n${failedStepsSection(evidence.summary)}\nFix the cause, commit, and end your turn; 10db runs the gate again.\n\nGate output (end):\n\`\`\`\n${evidence.summary}\n\`\`\``;

/** What a session is told when 10db merged the base into its branch and left conflict markers. */
function mergeSection(base: string, paths: readonly string[]): string {
  return [
    `10db merged ${base} into your branch, and both sides changed the same lines of these files, so git left its conflict markers (<<<<<<<, =======, >>>>>>>, and ||||||| for the common ancestor) in them:`,
    bullets(paths),
    '',
    `Resolve each one: keep what both sides do, in one version of the code that has both. A signature, type or field one side changed also changes its callers on the other side, anywhere in the repository, so find them (the typecheck and the tests name them) and adapt them. Edit the files with the Edit tool, and commit each file you changed through mcp__10db__commit, naming every path, with the markers gone. A file outside your claims needs mcp__10db__request_claim for its area first, as any other edit does.`,
    '',
    'Never run git merge, checkout, reset or restore: the merge is already made and committed, and only the markers are left. Never edit a generated file (packages/contracts/generated, packages/db/drizzle) by hand: 10db makes them again from the sources once you are done, so resolve the sources and leave those alone.',
    '',
    `If a resolution would change what either side does, not only put the two together (the sides disagree on a behaviour, a name or a value, or one deletes what the other uses), do not guess: call mcp__10db__ask_human naming the files and why, and wait for the answer. Otherwise end your turn once the markers are gone and committed; 10db runs the gate on the merged branch.`,
  ].join('\n');
}

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
      return [
        brief,
        ...(input.evidence ? [gateFailure(input.evidence, input.step.tools)] : []),
        answer,
      ].join('\n\n');
    }
    case 'feedback': {
      const message = input.feedback?.message ?? "The builder wrote in the task's thread.";
      if (input.action.providerSessionId !== null) return message;
      // No conversation to resume: a fresh session starts from the handoff, then the thread's digest,
      // then the builder's message (Workbench spec §6.3).
      const brief =
        input.handoff && briefedFromHandoff(input.action, input.handoff, input.evidence)
          ? fromHandoff(input.handoff)
          : 'The previous session left no handoff, so inspect git status first.';
      return [brief, ...(input.feedback?.digest ? [input.feedback.digest] : []), message].join(
        '\n\n',
      );
    }
    case 'fix': {
      const gate = input.evidence
        ? gateFailure(input.evidence, input.step.tools)
        : "The gate failed and 10db kept no output from it. Run the changed packages' tests, typecheck and lint, fix the cause, commit, and end your turn; 10db runs the gate again.";
      // A fix session that was cut off left a handoff after the failure; the next one starts from it.
      return input.handoff && briefedFromHandoff(input.action, input.handoff, input.evidence)
        ? `${fromHandoff(input.handoff)}\n\n${gate}`
        : gate;
    }
    case 'uncommitted':
      return `Your step ended with changes in your claims that are not committed:\n${bullets(input.action.paths)}\nCommit each one through mcp__10db__commit, naming every path, then end your turn. 10db runs the gate once they are committed.`;
    case 'merge':
      return mergeSection(input.action.base, input.action.paths);
    case 'verify':
      return 'Verify the work against the acceptance criteria, commit anything outstanding, and end your turn.';
    case 'builder_review':
      return 'The builder is checking the work; there is nothing to do until they answer.';
    case 'pass_review':
      return 'The builder is looking at the page; there is nothing to do until they write.';
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

const FOLLOW_UPS_ELSEWHERE =
  '(It also filed follow-up tasks. They are separate tasks: do not do them in this one.)';

const FOLLOW_UP_HOW =
  'Title each follow-up as an outcome (what is true when it is done) and describe what you saw and where; 10db files it as a task in the Icebox column and names it in your result.';

/**
 * What a review role is told about its round. The first round lists every blocking finding at once;
 * a later round checks only the newest rejection (it already holds the older findings that were
 * still open) plus what the fix broke, and files anything else it sees as a follow-up task.
 */
function roundSection(step: StepBrief, earlierResults: readonly StepResult[]): string[] {
  if (!REVIEW_ROLES.includes(step.role)) return [];
  const rejections = earlierResults.filter((r) => r.verdict === Verdict.Reject);
  const latest = rejections.at(-1);
  if (!latest) {
    return [
      '',
      `This is round 1 of your step. If you reject, list every blocking finding you can see in one rejection, as numbered notes, so the fix can address them together. A real problem that does not block goes in the followUps list of mcp__10db__complete_step instead, not in the rejection. ${FOLLOW_UP_HOW}`,
    ];
  }
  return [
    '',
    `This is round ${String(rejections.length + 1)} of your step: the work was sent back after your last rejection. Check only whether each earlier finding is fixed, and what the fix's own changes broke. Do not read the whole change again for new problems.`,
    '',
    'Findings from your earlier rounds (check only these):',
    findingNotes(latest.summary),
    '',
    `Reject only for an earlier finding that is still not fixed or for something the fix's own changes broke, and number each one. A finding that is new and that the fix did not cause does not reject the work: put it in the followUps list of mcp__10db__complete_step. ${FOLLOW_UP_HOW} If every earlier finding is fixed and the fix broke nothing, approve.`,
  ];
}

function stepSection(input: PromptInput): string[] {
  const { step } = input;
  const lines = [
    `Your step: ${String(step.index + 1)} of ${String(step.count)}, ${step.role}, as ${step.personaName}.`,
  ];
  if (step.skills.length > 0) lines.push(`Skills to use: ${step.skills.join(', ')}.`);
  const codex = input.provider === Provider.Codex;
  // A Codex session has no plugin, so the skills it names are in the briefing itself.
  if (codex) for (const body of step.skillBodies ?? []) lines.push('', body);
  if (step.instructions) lines.push('', `How you work:\n${step.instructions}`);
  if (codex) lines.push('', CODEX_TOOL_NAMES);
  if (input.priorResults.length > 0) {
    lines.push('', 'Earlier steps:');
    for (const prior of input.priorResults) {
      const verdict = prior.result.verdict ? `: ${VERDICT_LABEL[prior.result.verdict]}` : '';
      const notes = findingNotes(prior.result.summary);
      lines.push(`--- ${prior.role} (${prior.personaName})${verdict}`, notes);
      // The follow-ups it filed are tasks of their own, so they are not this task's to do.
      if (notes !== prior.result.summary) lines.push(FOLLOW_UPS_ELSEWHERE);
      lines.push('---');
    }
  }
  if (input.previousResult) {
    const verdict = input.previousResult.verdict
      ? `: ${VERDICT_LABEL[input.previousResult.verdict]}`
      : '';
    lines.push('', `Your previous result${verdict}:`, input.previousResult.summary);
  }
  lines.push(...roundSection(step, input.earlierResults));
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
        input.step.tools === ToolAccess.ReadOnly
          ? readOnlyRules(input.step.role)
          : [
              ...(input.inPass === true ? PASS_RULES : RULES),
              ...(input.pictures === true ? [PICTURES_RULE] : []),
            ],
        input.sandboxed === true,
        input.provider,
        {
          instructionsLoaded: input.instructionsLoaded === true,
          setupLine: input.setupLine ?? null,
          webJudged: input.webJudged === true,
        },
      ),
    ),
    '',
    'Context pack:',
    renderKnowledge(input.contextPack),
    ...(input.denials && input.denials.length > 0 ? ['', ...renderDenials(input.denials)] : []),
    ...renderAnsweredCards(input.step.role, input.answeredCards),
    ...(input.renumbered ? ['', input.renumbered] : []),
    ...(input.uncarried ? ['', input.uncarried] : []),
    '',
    actionSection(input),
  ].join('\n');
}

/** The pack again after an emergency compaction (spec §5.3), with the knowledge text the session started with. */
export function compactionReinjection(
  pack: ContextPack,
  denials: readonly Denial[] = [],
  answered?: { readonly role: StepRole; readonly answeredCards: readonly AnsweredCard[] },
): string {
  const claims = pack.claims.map((c) => `${c.kind} ${c.name}`).join(', ') || '(none)';
  return [
    '10db: your conversation was compacted. Here is your context pack again:',
    '',
    `Task: ${pack.task.title}`,
    pack.task.description,
    '',
    'Acceptance criteria:',
    bullets(pack.task.acceptanceCriteria),
    '',
    `Your claims: ${claims}.`,
    '',
    renderKnowledge(pack),
    ...(pack.handoff ? ['', 'Latest handoff:', renderHandoff(pack.handoff)] : []),
    ...(denials.length > 0 ? ['', ...renderDenials(denials)] : []),
    ...(answered ? renderAnsweredCards(answered.role, answered.answeredCards) : []),
  ].join('\n');
}

/**
 * The one review of a Workbench pass's pull request (spec §8.3, D21): the diff as text, read once
 * with no tool. Its findings come back as numbered notes, the format `parseFindings` reads, so each
 * can be matched to the page whose file it names.
 */
export function passReviewPrompt(input: {
  readonly passName: string;
  /** The pages signed off, by title. */
  readonly pages: readonly string[];
  readonly diff: string;
  /** True when the diff was longer than 10db sends and was cut. */
  readonly truncated: boolean;
  /** True when the diff starts after the tip an earlier review read: only what changed since. */
  readonly sinceLastReview: boolean;
}): string {
  return [
    `You are reviewing the pull request of a Workbench pass, "${input.passName}": pages the builder worked through with agents and signed off by eye.`,
    `Pages: ${input.pages.length > 0 ? input.pages.join('; ') : '(none named)'}.`,
    input.sinceLastReview
      ? 'This diff is only what changed since the last review of this pull request.'
      : 'This diff is the whole pull request.',
    ...(input.truncated
      ? [
          'The diff was too long and is cut: review what is here, and say that the rest was not read.',
        ]
      : []),
    '',
    'List each real problem as a numbered note, one per line: `1. <SEVERITY> <path>:<line> <what is wrong and why>`, SEVERITY one of BLOCKING, MAJOR, MINOR. Name the file exactly as the diff does. Write nothing but the notes; with no problem, answer `No findings.`',
    '',
    '```diff',
    input.diff,
    '```',
  ].join('\n');
}
