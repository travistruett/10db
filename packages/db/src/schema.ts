import type {
  AaModelDto,
  AccountId,
  AccountSettings,
  AreaDef,
  BatchFailure,
  BatchId,
  BatchState,
  CiStopped,
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
  FailingCheckDto,
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
  ProjectLanding,
  ProposalId,
  PullRequestChecks,
  PullRequestMergeBlocked,
  PullRequestState,
  ProposalKind,
  Provider,
  QuestionCategory,
  RequiredChecksDto,
  RiskTag,
  RoutingRuleId,
  SessionId,
  SessionMode,
  Severity,
  SourceId,
  SourceKind,
  StepRole,
  SupportedAccountKind,
  TaskId,
  TaskLanding,
  TaskStatus,
  ToolAccess,
  ToolOpId,
  Urgency,
  WorkspaceMode,
  WorkstreamId,
  WorkstreamState,
  WorkstreamStep,
} from '@10db/contracts';
import { USAGE_HANDOFF_AT } from '@10db/contracts';
import { sql } from 'drizzle-orm';
import {
  customType,
  type AnySQLiteColumn,
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

/**
 * A workstream's step plan, as JSON text. A step stored before a field was added reads back with
 * that field's default, the one the contract gives it: `earlier` [] and `sentBack` 0. Nothing else
 * is checked here, so one odd row can't stop the board from loading.
 */
const workstreamSteps = customType<{ data: WorkstreamStep[]; driverData: string }>({
  dataType: () => 'text',
  toDriver: (steps) => JSON.stringify(steps),
  fromDriver: (stored) =>
    (JSON.parse(stored) as Partial<WorkstreamStep>[]).map(
      (step) => ({ earlier: [], sentBack: 0, ...step }) as WorkstreamStep,
    ),
});

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

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').$type<AccountId>().primaryKey(),
    kind: text('kind').$type<SupportedAccountKind>().notNull(),
    label: text('label').notNull(),
    payer: text('payer').notNull(),
    /** The email (subscription) or organization (keyed) a session must report; null when none is compared. */
    expectedIdentity: text('expected_identity'),
    /** The Claude Code config directory its sessions run on; null is Claude Code's default (the default account only). */
    configDir: text('config_dir'),
    /** The Keychain account (service `10db`) of the secret, for kinds that have one. */
    secretRef: text('secret_ref'),
    /** `sha256:` and 16 hex digits of the secret 10db last stored: the account's identity for keyed kinds. */
    secretFingerprint: text('secret_fingerprint'),
    settings: text('settings', { mode: 'json' }).$type<AccountSettings>().notNull(),
    laneCap: integer('lane_cap').notNull(),
    monthlyCapUsd: real('monthly_cap_usd'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('accounts_label_idx').on(t.label)],
);

export const projects = sqliteTable('projects', {
  id: text('id').$type<ProjectId>().primaryKey(),
  name: text('name').notNull(),
  repoPath: text('repo_path').notNull().unique(),
  gateCommand: text('gate_command'),
  changedCheckCommand: text('changed_check_command'),
  /** Runs in place of the gate when the base has required checks; set only with a gate command. */
  precheckCommand: text('precheck_command'),
  areas: text('areas', { mode: 'json' }).$type<AreaDef[]>().notNull(),
  hazards: text('hazards', { mode: 'json' }).$type<HazardDef[]>().notNull(),
  maxLanes: integer('max_lanes').notNull(),
  provider: text('provider').$type<Provider>().notNull(),
  accountId: text('account_id')
    .$type<AccountId>()
    .notNull()
    .references(() => accounts.id),
  /** The account the project left for its usage limit; 10db offers to move it back once that limit resets. */
  movedFromAccountId: text('moved_from_account_id')
    .$type<AccountId>()
    .references(() => accounts.id),
  /** When that limit resets, as the pause or the session reported it; null when nobody said. */
  moveBackAt: text('move_back_at'),
  /** The account 10db moves the project to on its own near its account's usage limit. */
  fallbackAccountId: text('fallback_account_id')
    .$type<AccountId>()
    .references(() => accounts.id),
  /** The share of the account's usage limit at which the project hands off. */
  usageHandoffAt: real('usage_handoff_at').notNull().default(USAGE_HANDOFF_AT),
  /** Lets the lane's sandboxed commands bind and connect on localhost. */
  sandboxLoopback: integer('sandbox_loopback', { mode: 'boolean' }).notNull().default(false),
  handoffPct: integer('handoff_pct').notNull(),
  nudgePct: integer('nudge_pct').notNull(),
  humanWaitMinutes: integer('human_wait_minutes').notNull(),
  flowId: text('flow_id')
    .$type<FlowId>()
    .references(() => flows.id),
  budgetCeiling: real('budget_ceiling'),
  delivery: text('delivery').$type<Delivery>().notNull().default('local'),
  baseBranch: text('base_branch').notNull().default('main'),
  /** What a finished task's pull request does unless its task says otherwise. */
  landing: text('landing').$type<ProjectLanding>().notNull().default('merge'),
  /** The branch of origin new tasks land in when `landing` is `branch`; null otherwise. */
  landingBranch: text('landing_branch'),
  prTitlePrefix: text('pr_title_prefix'),
  /** Command prefixes a lane runs without a permission card, beyond the gate command. */
  allowedCommands: text('allowed_commands', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  /** Where a new task works unless it says otherwise; each task keeps its own (`tasks.workspace_mode`). */
  workspaceMode: text('workspace_mode').$type<WorkspaceMode>().notNull().default('shared'),
  /** Ignored directories of the main checkout a new worktree gets copies of. */
  worktreeSeed: text('worktree_seed', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'["node_modules"]'`),
  /** Area and hazard names whose tasks are proposed a separate copy. */
  isolate: text('isolate', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'["migrations","deps"]'`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * One branch and one pull request (batch delivery spec §3). The partial unique index allows one
 * unfinished shared batch per project, and any number of worktree batches; its state list matches
 * UNFINISHED_BATCH_STATES.
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
    /** The branch the batch is cut from and its pull request targets. */
    baseBranch: text('base_branch').notNull(),
    /** Whether the pull request merges by itself once its required checks pass. */
    autoMerge: integer('auto_merge', { mode: 'boolean' }).notNull().default(false),
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
    /**
     * The real path of the batch's worktree. Set in the CUTTING insert and cleared only once the
     * batch has finished, so an unfinished row without one is a shared batch.
     */
    worktreePath: text('worktree_path'),
    /**
     * Where a shared batch's cut found the builder's checkout, so the daemon can switch it back
     * when the batch ends: the branch it was on, or null when HEAD was detached, and the commit.
     * Cleared once the switch back is done or declined; a worktree batch never sets them.
     */
    returnBranch: text('return_branch'),
    returnSha: text('return_sha'),
    /**
     * What the PR watcher last read of the pull request. All null until the first read; the status
     * is whole once `prCheckedAt` is set. `prUnknownReason` is set only while the state is unknown.
     */
    prState: text('pr_state').$type<PullRequestState>(),
    prChecks: text('pr_checks').$type<PullRequestChecks>(),
    prFailingChecks: text('pr_failing_checks', { mode: 'json' }).$type<FailingCheckDto[]>(),
    prCheckedAt: text('pr_checked_at'),
    prUnknownReason: text('pr_unknown_reason'),
    /** The pull request's required checks as the watch last read them; kept on the root batch. */
    prRequired: text('pr_required', { mode: 'json' }).$type<RequiredChecksDto>(),
    /** Why GitHub will not merge the pull request as it is (`conflicts` or `behind`). */
    prMergeBlocked: text('pr_merge_blocked').$type<PullRequestMergeBlocked>(),
    /** A CI fix batch's root batch and the pull request head it fixes; null on any other batch. */
    ciFixOf: text('ci_fix_of')
      .$type<BatchId>()
      .references((): AnySQLiteColumn => batches.id),
    ciFixHead: text('ci_fix_head'),
    /** Why 10db stopped fixing the pull request's failing checks. */
    ciStopped: text('ci_stopped').$type<CiStopped>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('batches_project_idx').on(t.projectId),
    // One fix per root and head, so a second watch round or a restart starts none.
    uniqueIndex('batches_ci_fix_idx')
      .on(t.ciFixOf, t.ciFixHead)
      .where(sql`ci_fix_of IS NOT NULL AND ci_fix_head IS NOT NULL`),
    uniqueIndex('batches_one_unfinished')
      .on(t.projectId)
      .where(sql`state IN ('CUTTING', 'OPEN', 'SHIPPING', 'FAILED') AND worktree_path IS NULL`),
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
    /** The accepted proposal this task was filed from; null for a task made by hand. */
    proposalId: text('proposal_id')
      .$type<ProposalId>()
      .references(() => proposals.id),
    /** Where the work lands: `base`, `branch` (named by `landingBranch`) or `hold`. */
    landing: text('landing').$type<TaskLanding['kind']>().notNull().default('base'),
    landingBranch: text('landing_branch'),
    status: text('status').$type<TaskStatus>().notNull(),
    boardOrder: real('board_order').notNull(),
    /** Set: parked in that human column. Null: planned, with its column derived from its state. */
    boardColumnId: text('board_column_id')
      .$type<BoardColumnId>()
      .references(() => boardColumns.id),
    /**
     * Where the task runs when next started: the project's checkout or a copy of its own. Read only
     * while the task can be started; a finished task's batch says where it ran.
     */
    workspaceMode: text('workspace_mode').$type<WorkspaceMode>().notNull(),
    /** Why the placement was proposed; null when it was chosen or took the project default. */
    placementReason: text('placement_reason'),
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
    steps: workstreamSteps('steps')
      .notNull()
      .default(sql`'[]'`),
    stepIndex: integer('step_index').notNull().default(0),
    baseHead: text('base_head'),
    /**
     * The branch the workstream commits on, pinned when its first session starts and never read from
     * HEAD again; a batch's branch takes its place for batch work.
     */
    branch: text('branch'),
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
    /** When the builder put the queued workstream first in line; cleared once it gets a lane. */
    runNextAt: text('run_next_at'),
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
    accountId: text('account_id')
      .$type<AccountId>()
      .notNull()
      .references(() => accounts.id),
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
    cachedTokens: integer('cached_tokens').notNull().default(0),
    /** The SDK's cumulative dollars for a metered account; null for a subscription. */
    costUsd: real('cost_usd'),
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
  (t) => [
    index('sessions_workstream_idx').on(t.workstreamId),
    index('sessions_account_started_idx').on(t.accountId, t.startedAt),
  ],
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
    /**
     * What the claim is exclusive within: the project, or for an area in a worktree project, the
     * batch. The default only lets SQLite add the column; every insert writes it.
     */
    scope: text('scope')
      .$type<ProjectId | BatchId>()
      .notNull()
      .default(sql`''`),
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
      .on(t.scope, t.kind, t.name)
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
  foundIn: text('found_in'),
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
  command: text('command'),
  exitCode: integer('exit_code'),
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
    hosts: text('hosts', { mode: 'json' }).$type<string[]>().notNull().default([]),
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
