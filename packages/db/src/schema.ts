import type {
  AaModelDto,
  AreaDef,
  BatchFailure,
  BatchId,
  BatchState,
  BillingMode,
  BoardColumnId,
  ClaimId,
  ClaimKind,
  DecisionId,
  Delivery,
  DeviationId,
  Effort,
  EventType,
  EvidenceId,
  EvidenceKind,
  FlowId,
  FlowStepDef,
  HandoffId,
  HandoffInput,
  HazardDef,
  InboxAnswer,
  InboxItemId,
  InboxKind,
  InboxOption,
  InboxState,
  InboxTarget,
  McpVerdict,
  ModelPin,
  ModelProfileId,
  NextAction,
  PermissionRuleId,
  PersonaId,
  PersonId,
  ProfileSource,
  ProjectId,
  ProposalId,
  ProposalKind,
  Provider,
  QuestionCategory,
  RiskTag,
  RoutingRuleId,
  SessionId,
  SessionMode,
  Severity,
  SourceId,
  SourceKind,
  StepRole,
  TaskId,
  TaskStatus,
  ToolAccess,
  ToolOpId,
  Urgency,
  WorkstreamId,
  WorkstreamState,
  WorkstreamStep,
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

export const flows = sqliteTable('flows', {
  id: text('id').$type<FlowId>().primaryKey(),
  name: text('name').notNull().unique(),
  steps: text('steps', { mode: 'json' }).$type<FlowStepDef[]>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
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
  flowId: text('flow_id')
    .$type<FlowId>()
    .references(() => flows.id),
  budgetCeiling: real('budget_ceiling'),
  delivery: text('delivery').$type<Delivery>().notNull().default('local'),
  baseBranch: text('base_branch').notNull().default('main'),
  prTitlePrefix: text('pr_title_prefix'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * One branch and one pull request (batch delivery spec §3). The partial unique index allows one
 * unfinished batch per project; its state list matches UNFINISHED_BATCH_STATES.
 */
export const batches = sqliteTable(
  'batches',
  {
    id: text('id').$type<BatchId>().primaryKey(),
    projectId: text('project_id')
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    state: text('state').$type<BatchState>().notNull(),
    branch: text('branch'),
    baseBranch: text('base_branch').notNull(),
    baseSha: text('base_sha'),
    /** The GitHub `owner/name` from `gh repo view`, recorded at cut. */
    repo: text('repo'),
    prUrl: text('pr_url'),
    gateExitCode: integer('gate_exit_code'),
    gateLogPath: text('gate_log_path'),
    /** The shipping gate's process-group leader and its OS start time, so recovery can kill an orphaned gate. */
    gatePid: integer('gate_pid'),
    gatePidStart: text('gate_pid_start'),
    failure: text('failure').$type<BatchFailure>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('batches_project_idx').on(t.projectId),
    uniqueIndex('batches_one_unfinished')
      .on(t.projectId)
      .where(sql`state IN ('CUTTING', 'OPEN', 'SHIPPING', 'FAILED')`),
  ],
);

/** Columns the builder names and orders; a task in one is parked: never picked, never launched. */
export const boardColumns = sqliteTable(
  'board_columns',
  {
    id: text('id').$type<BoardColumnId>().primaryKey(),
    projectId: text('project_id')
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('board_columns_name_idx').on(t.projectId, t.name)],
);

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
    riskTags: text('risk_tags', { mode: 'json' })
      .$type<RiskTag[]>()
      .notNull()
      .default(sql`'[]'`),
    flowId: text('flow_id')
      .$type<FlowId>()
      .references(() => flows.id),
    status: text('status').$type<TaskStatus>().notNull(),
    boardOrder: real('board_order').notNull(),
    /** Set: parked in that human column. Null: planned, with its column derived from its state. */
    boardColumnId: text('board_column_id')
      .$type<BoardColumnId>()
      .references(() => boardColumns.id),
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
    batchId: text('batch_id')
      .$type<BatchId>()
      .references(() => batches.id),
    state: text('state').$type<WorkstreamState>().notNull(),
    nextAction: text('next_action', { mode: 'json' }).$type<NextAction>().notNull(),
    attempt: integer('attempt').notNull(),
    recoveryAttempts: integer('recovery_attempts').notNull(),
    model: text('model').notNull(),
    effort: text('effort').$type<Effort>().notNull(),
    steps: text('steps', { mode: 'json' })
      .$type<WorkstreamStep[]>()
      .notNull()
      .default(sql`'[]'`),
    stepIndex: integer('step_index').notNull().default(0),
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
  (t) => [
    index('workstreams_state_idx').on(t.state),
    index('workstreams_task_idx').on(t.taskId),
    index('workstreams_batch_idx').on(t.batchId),
  ],
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
    /**
     * The first context reading of a conversation that began from a handoff briefing, which its
     * handoff margin is measured from; null when it began bare. A resumed session copies it from
     * the session it resumes.
     */
    briefingBaselinePct: real('briefing_baseline_pct'),
    /**
     * Whether the conversation began from a handoff briefing. Kept apart from the baseline, so a
     * session resumed before the briefed session's first reading still knows to take one.
     */
    briefed: integer('briefed', { mode: 'boolean' }).notNull().default(false),
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

/** The builder's verdict on one repo MCP server config, per project. A changed config has a new hash and no verdict. */
export const mcpServerApprovals = sqliteTable(
  'mcp_server_approvals',
  {
    projectId: text('project_id')
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    serverName: text('server_name').notNull(),
    configHash: text('config_hash').notNull(),
    verdict: text('verdict').$type<McpVerdict>().notNull(),
    variables: text('variables', { mode: 'json' }).$type<string[]>().notNull(),
    sourceInboxId: text('source_inbox_id').$type<InboxItemId>(),
    /** A later answer for the same config replaces the verdict, so this is when it last changed. */
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.serverName, t.configHash] })],
);

export const personas = sqliteTable('personas', {
  id: text('id').$type<PersonaId>().primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  role: text('role').$type<StepRole>().notNull(),
  tools: text('tools').$type<ToolAccess>().notNull(),
  instructions: text('instructions').notNull(),
  skills: text('skills', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  minimumScore: real('minimum_score'),
  modelPin: text('model_pin', { mode: 'json' }).$type<ModelPin>(),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const people = sqliteTable('people', {
  id: text('id').$type<PersonId>().primaryKey(),
  handle: text('handle').notNull().unique(),
  name: text('name').notNull(),
  isBuilder: integer('is_builder', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Per project: which persona plays each role (spec §4). */
export const teamBindings = sqliteTable(
  'team_bindings',
  {
    projectId: text('project_id')
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    role: text('role').$type<StepRole>().notNull(),
    personaId: text('persona_id')
      .$type<PersonaId>()
      .notNull()
      .references(() => personas.id),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.role] })],
);

export const teamMembers = sqliteTable(
  'team_members',
  {
    projectId: text('project_id')
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    personId: text('person_id')
      .$type<PersonId>()
      .notNull()
      .references(() => people.id),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.personId] })],
);

export const routingRules = sqliteTable(
  'routing_rules',
  {
    id: text('id').$type<RoutingRuleId>().primaryKey(),
    projectId: text('project_id')
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    category: text('category').$type<QuestionCategory>().notNull(),
    area: text('area'),
    personId: text('person_id')
      .$type<PersonId>()
      .notNull()
      .references(() => people.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('routing_rules_project_idx').on(t.projectId)],
);

export const modelProfiles = sqliteTable(
  'model_profiles',
  {
    id: text('id').$type<ModelProfileId>().primaryKey(),
    provider: text('provider').$type<Provider>().notNull(),
    model: text('model').notNull(),
    effort: text('effort').$type<Effort>().notNull(),
    aaSlug: text('aa_slug'),
    intelligence: real('intelligence'),
    coding: real('coding'),
    agentic: real('agentic'),
    costPerTaskUsd: real('cost_per_task_usd'),
    outputTokensPerSecond: real('output_tokens_per_second'),
    source: text('source').$type<ProfileSource>().notNull(),
    indexVersion: text('index_version'),
    measuredAt: text('measured_at'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    stepsRun: integer('steps_run').notNull().default(0),
    firstPassSteps: integer('first_pass_steps').notNull().default(0),
    escalations: integer('escalations').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('model_profiles_key_idx').on(t.provider, t.model, t.effort)],
);

/** Artificial Analysis's free model list, kept only on this machine (AA's terms forbid sharing it); keyed by AA's slug. */
export const aaModels = sqliteTable('aa_models', {
  slug: text('slug').primaryKey(),
  data: text('data', { mode: 'json' }).$type<AaModelDto>().notNull(),
  updatedAt: text('updated_at').notNull(),
});
