import type {
  AreaDef,
  BillingMode,
  ClaimId,
  ClaimKind,
  DecisionId,
  DeviationId,
  Effort,
  EventType,
  EvidenceId,
  EvidenceKind,
  HandoffId,
  HandoffInput,
  HazardDef,
  InboxAnswer,
  InboxItemId,
  InboxKind,
  InboxOption,
  InboxState,
  InboxTarget,
  NextAction,
  PermissionRuleId,
  ProjectId,
  ProposalId,
  ProposalKind,
  Provider,
  QuestionCategory,
  SessionId,
  SessionMode,
  Severity,
  SourceId,
  SourceKind,
  TaskId,
  TaskStatus,
  ToolOpId,
  Urgency,
  WorkstreamId,
  WorkstreamState,
} from '@10db/contracts';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { Json } from './json';

const createdAt = () => text('created_at').notNull();
const updatedAt = () => text('updated_at').notNull();

/** App-wide settings keyed by name; values are JSON validated by their readers. */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const projects = sqliteTable('projects', {
  id: text('id').$type<ProjectId>().primaryKey(),
  name: text('name').notNull(),
  repoPath: text('repo_path').notNull().unique(),
  gateCommand: text('gate_command').notNull(),
  areas: text('areas', { mode: 'json' }).$type<AreaDef[]>().notNull(),
  hazards: text('hazards', { mode: 'json' }).$type<HazardDef[]>().notNull(),
  maxLanes: integer('max_lanes').notNull(),
  provider: text('provider').$type<Provider>().notNull(),
  billingMode: text('billing_mode').$type<BillingMode>().notNull(),
  model: text('model').notNull(),
  effort: text('effort').$type<Effort>().notNull(),
  handoffPct: integer('handoff_pct').notNull(),
  nudgePct: integer('nudge_pct').notNull(),
  humanWaitMinutes: integer('human_wait_minutes').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').$type<TaskId>().primaryKey(),
    projectId: text('project_id')
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    acceptanceCriteria: text('acceptance_criteria', { mode: 'json' }).$type<string[]>().notNull(),
    areas: text('areas', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status').$type<TaskStatus>().notNull(),
    boardOrder: real('board_order').notNull(),
    workspaceMode: text('workspace_mode').$type<'shared'>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('tasks_project_idx').on(t.projectId)],
);

export const taskDeps = sqliteTable(
  'task_deps',
  {
    taskId: text('task_id')
      .$type<TaskId>()
      .notNull()
      .references(() => tasks.id),
    dependsOnId: text('depends_on_id')
      .$type<TaskId>()
      .notNull()
      .references(() => tasks.id),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnId] })],
);

export const sources = sqliteTable('sources', {
  id: text('id').$type<SourceId>().primaryKey(),
  kind: text('kind').$type<SourceKind>().notNull(),
  ref: text('ref', { mode: 'json' }).$type<Record<string, Json>>().notNull(),
  createdAt: createdAt(),
});

export const proposals = sqliteTable('proposals', {
  id: text('id').$type<ProposalId>().primaryKey(),
  projectId: text('project_id')
    .$type<ProjectId>()
    .notNull()
    .references(() => projects.id),
  kind: text('kind').$type<ProposalKind>().notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').$type<'pending' | 'accepted' | 'rejected'>().notNull(),
  rationale: text('rationale'),
  sourceId: text('source_id')
    .$type<SourceId>()
    .notNull()
    .references(() => sources.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workstreams = sqliteTable(
  'workstreams',
  {
    id: text('id').$type<WorkstreamId>().primaryKey(),
    taskId: text('task_id')
      .$type<TaskId>()
      .notNull()
      .references(() => tasks.id),
    projectId: text('project_id')
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    state: text('state').$type<WorkstreamState>().notNull(),
    nextAction: text('next_action', { mode: 'json' }).$type<NextAction>().notNull(),
    attempt: integer('attempt').notNull(),
    recoveryAttempts: integer('recovery_attempts').notNull(),
    model: text('model').notNull(),
    effort: text('effort').$type<Effort>().notNull(),
    baseHead: text('base_head'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: text('lease_expires_at'),
    fence: integer('fence').notNull(),
    /** The running gate's process-group leader and its OS start time, so recovery can kill an orphaned gate. */
    gatePid: integer('gate_pid'),
    gatePidStart: text('gate_pid_start'),
    currentSessionId: text('current_session_id').$type<SessionId>(),
    contextPct: real('context_pct'),
    pausedUntil: text('paused_until'),
    failureReason: text('failure_reason'),
    lastActivityAt: text('last_activity_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('workstreams_state_idx').on(t.state), index('workstreams_task_idx').on(t.taskId)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').$type<SessionId>().primaryKey(),
    workstreamId: text('workstream_id')
      .$type<WorkstreamId>()
      .notNull()
      .references(() => workstreams.id),
    sequence: integer('sequence').notNull(),
    provider: text('provider').$type<Provider>().notNull(),
    providerSessionId: text('provider_session_id'),
    model: text('model').notNull(),
    effort: text('effort').$type<Effort>().notNull(),
    mode: text('mode').$type<SessionMode>().notNull(),
    mcpTokenHash: text('mcp_token_hash').notNull().unique(),
    pid: integer('pid'),
    /** The OS start time of `pid` (`ps -o lstart=`), so recovery never signals a reused PID. */
    pidStart: text('pid_start'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    exitReason: text('exit_reason'),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costUsd: real('cost_usd').notNull(),
    contextPct: real('context_pct'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sessions_workstream_idx').on(t.workstreamId)],
);

export const handoffs = sqliteTable('handoffs', {
  id: text('id').$type<HandoffId>().primaryKey(),
  workstreamId: text('workstream_id')
    .$type<WorkstreamId>()
    .notNull()
    .references(() => workstreams.id),
  sessionId: text('session_id')
    .$type<SessionId>()
    .notNull()
    .references(() => sessions.id),
  content: text('content', { mode: 'json' }).$type<HandoffInput>().notNull(),
  gitHead: text('git_head').notNull(),
  gitChangedFiles: text('git_changed_files', { mode: 'json' }).$type<string[]>().notNull(),
  gitCommits: text('git_commits', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: createdAt(),
});

export const claims = sqliteTable(
  'claims',
  {
    id: text('id').$type<ClaimId>().primaryKey(),
    projectId: text('project_id')
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    workstreamId: text('workstream_id')
      .$type<WorkstreamId>()
      .notNull()
      .references(() => workstreams.id),
    kind: text('kind').$type<ClaimKind>().notNull(),
    name: text('name').notNull(),
    exclusive: integer('exclusive', { mode: 'boolean' }).notNull(),
    leaseExpiresAt: text('lease_expires_at').notNull(),
    releasedAt: text('released_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('claims_active_unique')
      .on(t.projectId, t.kind, t.name)
      .where(sql`released_at IS NULL`),
    index('claims_workstream_idx').on(t.workstreamId),
  ],
);

export const inboxItems = sqliteTable(
  'inbox_items',
  {
    id: text('id').$type<InboxItemId>().primaryKey(),
    projectId: text('project_id')
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    kind: text('kind').$type<InboxKind>().notNull(),
    state: text('state').$type<InboxState>().notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    options: text('options', { mode: 'json' }).$type<InboxOption[]>().notNull(),
    recommendation: text('recommendation'),
    category: text('category').$type<QuestionCategory>().notNull(),
    urgency: text('urgency').$type<Urgency>().notNull(),
    assignee: text('assignee').notNull(),
    detail: text('detail', { mode: 'json' }).$type<Record<string, Json>>(),
    answer: text('answer', { mode: 'json' }).$type<InboxAnswer>(),
    foldKey: text('fold_key'),
    targets: text('targets', { mode: 'json' }).$type<InboxTarget[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('inbox_state_idx').on(t.state), index('inbox_fold_idx').on(t.projectId, t.foldKey)],
);

export const permissionRules = sqliteTable('permission_rules', {
  id: text('id').$type<PermissionRuleId>().primaryKey(),
  projectId: text('project_id')
    .$type<ProjectId>()
    .notNull()
    .references(() => projects.id),
  workstreamId: text('workstream_id').$type<WorkstreamId>(),
  toolName: text('tool_name').notNull(),
  pattern: text('pattern'),
  sourceInboxId: text('source_inbox_id').$type<InboxItemId>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const toolOps = sqliteTable(
  'tool_ops',
  {
    id: text('id').$type<ToolOpId>().primaryKey(),
    workstreamId: text('workstream_id')
      .$type<WorkstreamId>()
      .notNull()
      .references(() => workstreams.id),
    sessionId: text('session_id').$type<SessionId>().notNull(),
    opId: text('op_id').notNull(),
    tool: text('tool').notNull(),
    result: text('result', { mode: 'json' }).$type<Json>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tool_ops_unique').on(t.workstreamId, t.opId)],
);

export const evidence = sqliteTable('evidence', {
  id: text('id').$type<EvidenceId>().primaryKey(),
  workstreamId: text('workstream_id')
    .$type<WorkstreamId>()
    .notNull()
    .references(() => workstreams.id),
  kind: text('kind').$type<EvidenceKind>().notNull(),
  command: text('command').notNull(),
  exitCode: integer('exit_code').notNull(),
  summary: text('summary').notNull(),
  logPath: text('log_path'),
  commitShas: text('commit_shas', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: createdAt(),
});

export const decisions = sqliteTable('decisions', {
  id: text('id').$type<DecisionId>().primaryKey(),
  projectId: text('project_id')
    .$type<ProjectId>()
    .references(() => projects.id),
  question: text('question').notNull(),
  choice: text('choice').notNull(),
  rationale: text('rationale').notNull(),
  decidedBy: text('decided_by').notNull(),
  scope: text('scope').$type<'you' | 'project' | 'area'>().notNull(),
  area: text('area'),
  supersedesId: text('supersedes_id').$type<DecisionId>(),
  sourceId: text('source_id')
    .$type<SourceId>()
    .notNull()
    .references(() => sources.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const deviations = sqliteTable('deviations', {
  id: text('id').$type<DeviationId>().primaryKey(),
  projectId: text('project_id')
    .$type<ProjectId>()
    .notNull()
    .references(() => projects.id),
  workstreamId: text('workstream_id').$type<WorkstreamId>(),
  cause: text('cause').notNull(),
  severity: text('severity').$type<Severity>().notNull(),
  signedReason: text('signed_reason').notNull(),
  resolution: text('resolution'),
  sourceId: text('source_id')
    .$type<SourceId>()
    .notNull()
    .references(() => sources.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const events = sqliteTable('events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  type: text('type').$type<EventType>().notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  data: text('data', { mode: 'json' }).$type<Record<string, Json>>().notNull(),
  at: text('at').notNull(),
});
