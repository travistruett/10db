type ValueOf<T> = T[keyof T];

export const WorkstreamState = {
  Queued: 'QUEUED',
  /** A queued run the builder set aside before it ran: it keeps its batch and worktree and takes no lane. */
  Held: 'HELD',
  Starting: 'STARTING',
  Running: 'RUNNING',
  HandingOff: 'HANDING_OFF',
  Verifying: 'VERIFYING',
  Done: 'DONE',
  WaitingHuman: 'WAITING_HUMAN',
  PausedLimit: 'PAUSED_LIMIT',
  Recovering: 'RECOVERING',
  TakenOver: 'TAKEN_OVER',
  Failed: 'FAILED',
  Cancelled: 'CANCELLED',
} as const;
export type WorkstreamState = ValueOf<typeof WorkstreamState>;

export const InboxKind = {
  Question: 'question',
  Permission: 'permission',
  Proposal: 'proposal',
  Review: 'review',
  Flag: 'flag',
  /** A finished task in a project with no gate, waiting for the builder to approve or send it back. */
  Check: 'check',
} as const;
export type InboxKind = ValueOf<typeof InboxKind>;

export const InboxState = {
  Open: 'OPEN',
  Answered: 'ANSWERED',
  Delivering: 'DELIVERING',
  Resolved: 'RESOLVED',
  Cancelled: 'CANCELLED',
  Expired: 'EXPIRED',
} as const;
export type InboxState = ValueOf<typeof InboxState>;

export const ClaimKind = { Area: 'area', Hazard: 'hazard' } as const;
export type ClaimKind = ValueOf<typeof ClaimKind>;

export const Provider = { Claude: 'claude' } as const;
export type Provider = ValueOf<typeof Provider>;

export const Effort = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
  Max: 'max',
} as const;
export type Effort = ValueOf<typeof Effort>;

export const TaskStatus = { Open: 'open', Done: 'done', Cancelled: 'cancelled' } as const;
export type TaskStatus = ValueOf<typeof TaskStatus>;

export const BoardStatus = {
  Backlog: 'backlog',
  Ready: 'ready',
  InProgress: 'in_progress',
  /** Shipped, with its pull request open: not done until the pull request merges. */
  InReview: 'in_review',
  Blocked: 'blocked',
  Done: 'done',
} as const;
export type BoardStatus = ValueOf<typeof BoardStatus>;

export const PermissionChoice = {
  AllowOnce: 'allow_once',
  AllowWorkstream: 'allow_workstream',
  AllowProject: 'allow_project',
  Deny: 'deny',
} as const;
export type PermissionChoice = ValueOf<typeof PermissionChoice>;

export const Urgency = { Low: 'low', Normal: 'normal', High: 'high' } as const;
export type Urgency = ValueOf<typeof Urgency>;

export const QuestionCategory = {
  Product: 'product',
  Design: 'design',
  Engineering: 'engineering',
  Environment: 'environment',
  Other: 'other',
} as const;
export type QuestionCategory = ValueOf<typeof QuestionCategory>;

/** Answers in these categories are recorded as decisions (spec §7). */
export const DECISION_CATEGORIES: readonly QuestionCategory[] = [
  QuestionCategory.Product,
  QuestionCategory.Design,
  QuestionCategory.Engineering,
];

export const ProposalKind = {
  NewTask: 'new_task',
  ChangeTask: 'change_task',
  Principle: 'principle',
  Note: 'note',
} as const;
export type ProposalKind = ValueOf<typeof ProposalKind>;

export const Severity = { Info: 'info', Warn: 'warn', Error: 'error' } as const;
export type Severity = ValueOf<typeof Severity>;

export const SourceKind = {
  InboxAnswer: 'inbox_answer',
  Agent: 'agent',
  Daemon: 'daemon',
  Builder: 'builder',
} as const;
export type SourceKind = ValueOf<typeof SourceKind>;

export const EvidenceKind = { Gate: 'gate', Agent: 'agent', Builder: 'builder' } as const;
export type EvidenceKind = ValueOf<typeof EvidenceKind>;

export const SessionMode = { Managed: 'managed', Terminal: 'terminal' } as const;
export type SessionMode = ValueOf<typeof SessionMode>;

/** When the daemon holds `caffeinate` (spec §3). */
export const KeepAwakeMode = {
  Off: 'off',
  WhileRunning: 'while_running',
  Always: 'always',
} as const;
export type KeepAwakeMode = ValueOf<typeof KeepAwakeMode>;

/** The roles a flow step can have (spec §4 `flows`). */
export const StepRole = {
  Plan: 'plan',
  PlanReview: 'plan_review',
  Implement: 'implement',
  Review: 'review',
  Qa: 'qa',
} as const;
export type StepRole = ValueOf<typeof StepRole>;

/** Roles that judge work and must give a verdict; every role but implement is read-only. */
export const REVIEW_ROLES: readonly StepRole[] = [
  StepRole.PlanReview,
  StepRole.Review,
  StepRole.Qa,
];

export const ToolAccess = { ReadOnly: 'read_only', Edit: 'edit' } as const;
export type ToolAccess = ValueOf<typeof ToolAccess>;

/** Risks that raise a step's floor (spec §5.2: trust boundaries, migrations, auth). */
export const RiskTag = {
  Security: 'security',
  Auth: 'auth',
  Migration: 'migration',
  Dependency: 'dependency',
} as const;
export type RiskTag = ValueOf<typeof RiskTag>;

export const Verdict = { Approve: 'approve', Reject: 'reject' } as const;
export type Verdict = ValueOf<typeof Verdict>;

/** A skipped step never enters a plan, so there is no skipped status. */
export const StepStatus = {
  Pending: 'pending',
  Running: 'running',
  Done: 'done',
  Failed: 'failed',
} as const;
export type StepStatus = ValueOf<typeof StepStatus>;

/** The Artificial Analysis indexes a step can be measured against. */
export const ScoreKind = {
  Intelligence: 'intelligence',
  Coding: 'coding',
  Agentic: 'agentic',
} as const;
export type ScoreKind = ValueOf<typeof ScoreKind>;

/** The score each role is routed on (the builder's choice): code is measured by coding, QA by agentic work. */
export const ROLE_SCORE: Readonly<Record<StepRole, ScoreKind>> = {
  plan: ScoreKind.Intelligence,
  plan_review: ScoreKind.Intelligence,
  implement: ScoreKind.Coding,
  review: ScoreKind.Intelligence,
  qa: ScoreKind.Agentic,
};

/** Where a profile's scores come from: the AA sync, or the builder's own numbers. */
export const ProfileSource = { Aa: 'aa', Manual: 'manual' } as const;
export type ProfileSource = ValueOf<typeof ProfileSource>;

/** How a project's finished work leaves the machine (batch delivery spec §3). */
export const Delivery = { Local: 'local', PullRequest: 'pull_request' } as const;
export type Delivery = ValueOf<typeof Delivery>;

/** Where a project's tasks work: the one checkout, or a git worktree per started task. */
export const WorkspaceMode = { Shared: 'shared', Worktree: 'worktree' } as const;
export type WorkspaceMode = ValueOf<typeof WorkspaceMode>;

/** A batch's lifecycle (batch delivery spec §4). */
export const BatchState = {
  Cutting: 'CUTTING',
  Open: 'OPEN',
  Shipping: 'SHIPPING',
  Shipped: 'SHIPPED',
  Closed: 'CLOSED',
  Failed: 'FAILED',
  Abandoned: 'ABANDONED',
} as const;
export type BatchState = ValueOf<typeof BatchState>;

/** Where a shipped batch's pull request stands on GitHub; `unknown` when gh could not say. */
export const PullRequestState = {
  Open: 'open',
  Merged: 'merged',
  Closed: 'closed',
  Unknown: 'unknown',
} as const;
export type PullRequestState = ValueOf<typeof PullRequestState>;

/** A pull request's checks; `none` means the pull request has no checks at all. */
export const PullRequestChecks = {
  Pending: 'pending',
  Passing: 'passing',
  Failing: 'failing',
  None: 'none',
  Unknown: 'unknown',
} as const;
export type PullRequestChecks = ValueOf<typeof PullRequestChecks>;

/** Why shipping stopped; the batch's flag card carries the detail. */
export const BatchFailure = {
  WrongBranch: 'wrong_branch',
  DirtyCheckout: 'dirty_checkout',
  GateFailed: 'gate_failed',
  GateTimedOut: 'gate_timed_out',
  PushRejected: 'push_rejected',
  GhUnavailable: 'gh_unavailable',
  Network: 'network',
} as const;
export type BatchFailure = ValueOf<typeof BatchFailure>;

/** A goal's lifecycle (goals spec §6). Phase 1 writes only `draft`. */
export const GoalState = {
  Draft: 'draft',
  Running: 'running',
  Waiting: 'waiting',
  Paused: 'paused',
  Done: 'done',
  Cancelled: 'cancelled',
} as const;
export type GoalState = ValueOf<typeof GoalState>;

/** How a goal criterion is proven (goals spec §5). */
export const CriterionCheck = {
  Task: 'task',
  Merged: 'merged',
  Command: 'command',
  Accept: 'accept',
} as const;
export type CriterionCheck = ValueOf<typeof CriterionCheck>;

export const CriterionState = { Unproven: 'unproven', Proven: 'proven' } as const;
export type CriterionState = ValueOf<typeof CriterionState>;

/**
 * What Factory's one line says about a goal or the Ungrouped group (goals spec §8). The daemon
 * derives it from the first match in this order.
 */
export const GoalStatus = {
  Failed: 'failed',
  WaitingOnYou: 'waiting_on_you',
  WaitingOnSomeone: 'waiting_on_someone',
  Paused: 'paused',
  Running: 'running',
  /** Every task is done but a pull request is still open. */
  Shipping: 'shipping',
  NotStarted: 'not_started',
  Done: 'done',
} as const;
export type GoalStatus = ValueOf<typeof GoalStatus>;
