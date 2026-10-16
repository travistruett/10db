type ValueOf<T> = T[keyof T];

export const WorkstreamState = {
  Queued: 'QUEUED',
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

export const BillingMode = {
  Subscription: 'subscription',
  ApiKey: 'api_key',
  Bedrock: 'bedrock',
} as const;
export type BillingMode = ValueOf<typeof BillingMode>;

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

export const EvidenceKind = { Gate: 'gate', Agent: 'agent' } as const;
export type EvidenceKind = ValueOf<typeof EvidenceKind>;

export const SessionMode = { Managed: 'managed', Terminal: 'terminal' } as const;
export type SessionMode = ValueOf<typeof SessionMode>;
