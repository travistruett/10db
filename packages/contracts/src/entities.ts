import { z } from 'zod';
import { USAGE_HANDOFF_AT, USAGE_HANDOFF_MAX, USAGE_HANDOFF_MIN } from './accounts';
import { AllowedCommands } from './allowed-commands';
import { BranchName, PrTitlePrefix } from './git-names';
import {
  AccountId,
  BatchId,
  BoardColumnId,
  EvidenceId,
  FlowId,
  HandoffId,
  InboxItemId,
  PermissionRuleId,
  ProjectId,
  SessionId,
  TaskId,
  WorkstreamId,
} from './ids';
import {
  BoardStatus,
  Delivery,
  Effort,
  EvidenceKind,
  InboxKind,
  InboxState,
  Provider,
  QuestionCategory,
  RiskTag,
  TaskStatus,
  Urgency,
  WorkspaceMode,
  WorkstreamState,
} from './states';
import { WorkstreamStep } from './steps';

const Name = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and hyphens');
const Timestamp = z.iso.datetime();

const CONTROL_CHARACTER = /\p{Cc}/u;
/**
 * A task or batch title: one line, since in pull-request delivery it becomes the pull request's
 * title, and GitHub refuses one with a newline only after the branch is pushed.
 */
export const Title = z
  .string()
  .min(1)
  .max(200)
  .refine((t) => !CONTROL_CHARACTER.test(t), 'no control characters such as newlines or tabs');

export const AreaDef = z.object({ name: Name, globs: z.array(z.string().min(1)).min(1) });
export type AreaDef = z.infer<typeof AreaDef>;

/**
 * A hazard is an exclusive claim. `commands` are command prefixes that need it, as words: the guard
 * drops flags (and the value of flags like `--filter`) before comparing, so `pnpm -w add x` and
 * `pnpm --filter y add x` both match `pnpm add`.
 */
export const HazardDef = AreaDef.extend({ commands: z.array(z.string().min(1)) });
export type HazardDef = z.infer<typeof HazardDef>;

/** Brackets and braces in a path pattern must close, in order. */
function bracketsClose(glob: string): boolean {
  const open: string[] = [];
  for (const ch of glob) {
    if (ch === '[') open.push(']');
    else if (ch === '{') open.push('}');
    else if ((ch === ']' || ch === '}') && open.pop() !== ch) return false;
  }
  return open.length === 0;
}

/**
 * A path pattern the builder writes in Settings: relative to the project folder, `/` between
 * folders, no `..`, and brackets and braces that close.
 */
export const PathPattern = z
  .string()
  .min(1)
  .refine(
    (g) => !g.startsWith('/') && !/^[A-Za-z]:/.test(g),
    'must be relative to the project folder',
  )
  .refine((g) => !g.includes('\\'), 'use / between folders, not a backslash')
  .refine((g) => !g.split('/').includes('..'), 'must not go up a folder with ..')
  .refine(bracketsClose, 'has a [ or { that is never closed');

export const DEFAULT_HAZARDS: readonly HazardDef[] = [
  {
    name: 'migrations',
    globs: ['**/migrations/**', '**/drizzle/**'],
    commands: ['drizzle-kit generate', 'pnpm db:migrate'],
  },
  {
    name: 'deps',
    globs: ['**/package.json', 'pnpm-lock.yaml', '**/Cargo.toml', '**/Cargo.lock'],
    commands: [
      'pnpm add',
      'pnpm remove',
      'pnpm rm',
      'pnpm install',
      'pnpm i',
      'pnpm update',
      'pnpm up',
      'pnpm uninstall',
      'pnpm un',
      'pnpm upgrade',
      'npm install',
      'npm i',
      'npm add',
      // Installs from the lockfile and changes no manifest, but it deletes node_modules first, which
      // every lane in a shared checkout reads.
      'npm ci',
      'npm uninstall',
      'npm un',
      'yarn add',
      'cargo add',
      'cargo remove',
      'cargo update',
    ],
  },
  {
    name: 'harness',
    globs: ['AGENTS.md', '**/AGENTS.md', '.claude/**', '.codex/**'],
    commands: [],
  },
];

/** One directory name copied into a worktree: no `/`, not `.`, `..` or `.git`, no NUL, 1-255 chars. */
export const WorktreeSeedName = z
  .string()
  .min(1)
  .max(255)
  .refine((n) => !n.includes('/') && !n.includes('\0') && !['.', '..', '.git'].includes(n), {
    message: 'Name one directory: no slash, ".", ".." or ".git"',
  });
export type WorktreeSeedName = z.infer<typeof WorktreeSeedName>;

/** The ignored directories a worktree borrows from the main checkout unless a project says otherwise. */
export const DEFAULT_WORKTREE_SEED = ['node_modules'] as const;

const WorktreeSeed = z.array(WorktreeSeedName).max(32);

const UsageHandoffAt = z.number().min(USAGE_HANDOFF_MIN).max(USAGE_HANDOFF_MAX);

export const ProjectInput = z
  .object({
    name: z.string().min(1),
    repoPath: z.string().startsWith('/'),
    gateCommand: z.string().min(1),
    areas: z.array(AreaDef).min(1),
    hazards: z.array(HazardDef).default(() => [...DEFAULT_HAZARDS]),
    maxLanes: z.int().min(1).max(16).default(2),
    // Defaults hand off at about 400k tokens on a 1M window (spikes summary). Low minimums let acceptance runs
    // force a handoff on a large context window.
    handoffPct: z.int().min(5).max(95).default(40),
    nudgePct: z.int().min(6).max(98).default(50),
    humanWaitMinutes: z.int().min(1).max(240).default(10),
    flowId: FlowId.nullable().default(null),
    /** The most a task may cost, in USD, compared with a profile's AA cost per task; null for no ceiling. */
    budgetCeiling: z.number().positive().nullable().default(null),
    /** How finished work leaves the machine: on the checked-out branch, or as a batch's pull request. */
    delivery: z.enum(Delivery).default(Delivery.Local),
    /** The branch on `origin` a batch is cut from and its pull request targets. */
    baseBranch: BranchName.default('main'),
    /**
     * `pull_request` delivery titles each PR `<prefix>: <batch title>`; null derives
     * `<type>(<scope>): <subject>` from the batch's tasks and the paths it changed.
     */
    prTitlePrefix: PrTitlePrefix.nullable().default(null),
    /** The account that pays; absent means the default account. */
    accountId: AccountId.optional(),
    /**
     * The account 10db moves the project to on its own near its account's usage limit. Claude Code
     * reports usage short of the limit only for a subscription, so on a keyed account only the hard
     * limit moves it.
     */
    fallbackAccountId: AccountId.nullable().default(null),
    /** The share of the account's usage limit at which the project hands off. */
    usageHandoffAt: UsageHandoffAt.default(USAGE_HANDOFF_AT),
    /** Command prefixes a lane runs without a permission card, beyond the gate command. */
    allowedCommands: AllowedCommands.default([]),
    /**
     * Lets the lane's sandboxed commands bind and connect on localhost, which opens every local port
     * to the lane; read when each session starts.
     */
    sandboxLoopback: z.boolean().default(false),
    /** Where tasks work: the one checkout, or a git worktree per started task (pull request delivery only). */
    workspaceMode: z.enum(WorkspaceMode).default(WorkspaceMode.Shared),
    /** Ignored directories of the main checkout a new worktree gets copies of. */
    worktreeSeed: WorktreeSeed.default(() => [...DEFAULT_WORKTREE_SEED]),
  })
  .refine((p) => p.nudgePct > p.handoffPct, {
    message: 'nudgePct must be above handoffPct',
    path: ['nudgePct'],
  })
  .refine(
    (p) => p.workspaceMode !== WorkspaceMode.Worktree || p.delivery === Delivery.PullRequest,
    {
      message: 'A worktree per task needs pull request delivery',
      path: ['workspaceMode'],
    },
  );
export type ProjectInput = z.input<typeof ProjectInput>;
export type ProjectConfig = z.output<typeof ProjectInput>;

export const ProjectDto = z.object({
  id: ProjectId,
  name: z.string(),
  repoPath: z.string(),
  gateCommand: z.string(),
  areas: z.array(AreaDef),
  hazards: z.array(HazardDef),
  maxLanes: z.int(),
  provider: z.enum(Provider),
  accountId: AccountId,
  /** The account the project left for its usage limit; 10db offers to move it back once that limit resets. */
  movedFromAccountId: AccountId.nullable(),
  /**
   * When that limit resets, as the pause or the session reported it: when 10db asks about the move
   * back. Null with a `movedFromAccountId` when nobody said; 10db then asks after its default pause.
   */
  moveBackAt: Timestamp.nullable(),
  fallbackAccountId: AccountId.nullable(),
  usageHandoffAt: z.number(),
  handoffPct: z.int(),
  nudgePct: z.int(),
  humanWaitMinutes: z.int(),
  flowId: FlowId.nullable(),
  budgetCeiling: z.number().nullable(),
  delivery: z.enum(Delivery),
  baseBranch: z.string(),
  prTitlePrefix: z.string().nullable(),
  allowedCommands: z.array(z.string()),
  sandboxLoopback: z.boolean(),
  workspaceMode: z.enum(WorkspaceMode),
  worktreeSeed: z.array(z.string()),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ProjectDto = z.infer<typeof ProjectDto>;

/** Fields the builder can change after creation; the nudge/handoff rule is checked against the merged values. */
export const ProjectPatch = z
  .object({
    name: z.string().min(1),
    gateCommand: z.string().min(1),
    maxLanes: z.int().min(1).max(16),
    handoffPct: z.int().min(5).max(95),
    nudgePct: z.int().min(6).max(98),
    humanWaitMinutes: z.int().min(1).max(240),
    flowId: FlowId.nullable(),
    /** The most a task may cost, in USD, compared with a profile's AA cost per task; null for no ceiling. */
    budgetCeiling: z.number().positive().nullable(),
    delivery: z.enum(Delivery),
    baseBranch: BranchName,
    prTitlePrefix: PrTitlePrefix.nullable(),
    /** Replaces the project's areas; one that a running task holds can't be removed or renamed. */
    areas: z.array(AreaDef.extend({ globs: z.array(PathPattern).min(1) })).min(1),
    /** Replaces the project's hazards, commands included. */
    hazards: z.array(HazardDef.extend({ globs: z.array(PathPattern).min(1) })),
    /** Moves the project to another account; work in flight follows at each lane's next session. */
    accountId: AccountId,
    fallbackAccountId: AccountId.nullable(),
    usageHandoffAt: UsageHandoffAt,
    allowedCommands: AllowedCommands,
    sandboxLoopback: z.boolean(),
    workspaceMode: z.enum(WorkspaceMode),
    worktreeSeed: WorktreeSeed,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' })
  .refine(
    (p) => {
      const names = [...(p.areas ?? []), ...(p.hazards ?? [])].map((d) => d.name);
      return new Set(names).size === names.length;
    },
    { message: 'An area or hazard name is used twice', path: ['areas'] },
  );
export type ProjectPatch = z.infer<typeof ProjectPatch>;

export const TaskInput = z.object({
  title: Title,
  description: z.string().default(''),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  areas: z.array(Name).min(1),
  dependsOn: z.array(TaskId).default([]),
  riskTags: z.array(z.enum(RiskTag)).default([]),
  flowId: FlowId.nullable().default(null),
});
export type TaskInput = z.input<typeof TaskInput>;
export type TaskConfig = z.output<typeof TaskInput>;

export const TaskDto = z.object({
  id: TaskId,
  projectId: ProjectId,
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  areas: z.array(z.string()),
  riskTags: z.array(z.enum(RiskTag)),
  flowId: FlowId.nullable(),
  status: z.enum(TaskStatus),
  boardOrder: z.number(),
  boardColumnId: BoardColumnId.nullable(),
  dependsOn: z.array(TaskId),
  boardStatus: z.enum(BoardStatus),
  workstreamId: WorkstreamId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TaskDto = z.infer<typeof TaskDto>;

export const TaskPatch = z
  .object({
    title: Title,
    description: z.string(),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    riskTags: z.array(z.enum(RiskTag)),
    flowId: FlowId.nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type TaskPatch = z.infer<typeof TaskPatch>;

/** What the runner does the next time the workstream gets a lane. */
export const NextAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }),
  z.object({ kind: z.literal('continue_from_handoff'), handoffId: HandoffId }),
  z.object({
    kind: z.literal('resume'),
    providerSessionId: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal('answer'),
    inboxId: InboxItemId,
    providerSessionId: z.string().min(1).nullable(),
  }),
  z.object({ kind: z.literal('fix'), evidenceId: EvidenceId }),
  /** The step ended with these changes in its claims uncommitted; the next session commits them. */
  z.object({ kind: z.literal('uncommitted'), paths: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('verify') }),
  /** Rerun a step a reviewer rejected; the rejecting step's notes are in its result. */
  z.object({ kind: z.literal('revise'), reviewStep: z.int().min(0) }),
]);
export type NextAction = z.infer<typeof NextAction>;

export const WorkstreamDto = z.object({
  id: WorkstreamId,
  taskId: TaskId,
  taskTitle: z.string(),
  projectId: ProjectId,
  /** The batch it runs in; null in local delivery. */
  batchId: BatchId.nullable(),
  state: z.enum(WorkstreamState),
  nextAction: NextAction,
  attempt: z.int(),
  recoveryAttempts: z.int(),
  model: z.string(),
  effort: z.enum(Effort),
  steps: z.array(WorkstreamStep),
  stepIndex: z.int().min(0),
  currentSessionId: SessionId.nullable(),
  sessionCount: z.int(),
  contextPct: z.number().nullable(),
  pausedUntil: Timestamp.nullable(),
  failureReason: z.string().nullable(),
  lastActivityAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type WorkstreamDto = z.infer<typeof WorkstreamDto>;

export const InboxOption = z.object({ label: z.string().min(1).max(80), description: z.string() });
export type InboxOption = z.infer<typeof InboxOption>;

export const InboxAnswer = z.object({
  choice: z.string().min(1),
  note: z.string().max(4000).optional(),
});
export type InboxAnswer = z.infer<typeof InboxAnswer>;

export const InboxTarget = z.object({
  workstreamId: WorkstreamId,
  sessionId: SessionId.nullable(),
});
export type InboxTarget = z.infer<typeof InboxTarget>;

export const InboxItemDto = z.object({
  id: InboxItemId,
  projectId: ProjectId,
  kind: z.enum(InboxKind),
  state: z.enum(InboxState),
  title: z.string(),
  body: z.string(),
  options: z.array(InboxOption),
  recommendation: z.string().nullable(),
  category: z.enum(QuestionCategory),
  urgency: z.enum(Urgency),
  assignee: z.string(),
  detail: z.record(z.string(), z.json()).nullable(),
  answer: InboxAnswer.nullable(),
  targets: z.array(InboxTarget),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type InboxItemDto = z.infer<typeof InboxItemDto>;

export const PermissionRuleDto = z.object({
  id: PermissionRuleId,
  projectId: ProjectId,
  workstreamId: WorkstreamId.nullable(),
  toolName: z.string(),
  pattern: z.string().nullable(),
  sourceInboxId: InboxItemId.nullable(),
  createdAt: Timestamp,
});
export type PermissionRuleDto = z.infer<typeof PermissionRuleDto>;

export const EvidenceDto = z.object({
  id: EvidenceId,
  workstreamId: WorkstreamId,
  kind: z.enum(EvidenceKind),
  command: z.string(),
  exitCode: z.int(),
  summary: z.string(),
  logPath: z.string().nullable(),
  commitShas: z.array(z.string()),
  createdAt: Timestamp,
});
export type EvidenceDto = z.infer<typeof EvidenceDto>;
