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
  GoalId,
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
import { DEFAULT_PROJECT_LANDING, ProjectLanding, TaskLanding } from './landing';
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
 * What a hazard is exclusive across. `copy`: one checkout, so tasks in separate worktrees hold it at
 * the same time and tasks sharing a checkout (shared mode, or one batch) queue. `project`: every task
 * of the project, whatever its checkout, because the hazard names something the copies share.
 */
export const HazardScope = { Copy: 'copy', Project: 'project' } as const;
export type HazardScope = (typeof HazardScope)[keyof typeof HazardScope];

/**
 * A hazard is an exclusive claim. `commands` are command prefixes that need it, as words: the guard
 * drops flags (and the value of flags like `--filter`) before comparing, so `pnpm -w add x` and
 * `pnpm --filter y add x` both match `pnpm add`. `scope` is absent in a project stored before
 * hazards had one; `hazardScope` reads it.
 */
export const HazardDef = AreaDef.extend({
  commands: z.array(z.string().min(1)),
  scope: z.enum([HazardScope.Copy, HazardScope.Project]).optional(),
});
export type HazardDef = z.infer<typeof HazardDef>;

/** The scope of the stock hazards, which a stored hazard of the same name with no scope takes. */
const DEFAULT_HAZARD_SCOPES: Readonly<Record<string, HazardScope>> = {
  migrations: HazardScope.Project,
  deps: HazardScope.Copy,
  harness: HazardScope.Copy,
};

/** A hazard's scope: its own, else its stock namesake's, else the whole project. */
export function hazardScope(hazard: Pick<HazardDef, 'name' | 'scope'>): HazardScope {
  return hazard.scope ?? DEFAULT_HAZARD_SCOPES[hazard.name] ?? HazardScope.Project;
}

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
    commands: ['drizzle-kit generate', 'pnpm db:migrate', 'npm db:migrate', 'yarn db:migrate'],
    // The migrations run against a database every copy shares.
    scope: HazardScope.Project,
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
      'pnpm it',
      'pnpm ci',
      'pnpm install-test',
      'pnpm clean-install',
      'bun add',
      'bun remove',
      'bun install',
      'bun i',
      'bun update',
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
      'npm in',
      'npm ins',
      'npm inst',
      'npm insta',
      'npm instal',
      'npm isnt',
      'npm isnta',
      'npm isntal',
      'npm isntall',
      'npm it',
      'npm cit',
      'npm install-test',
      'npm install-ci-test',
      'npm r',
      'npm rm',
      'npm remove',
      'npm update',
      'npm up',
      'npm upgrade',
      'yarn add',
      'yarn remove',
      'yarn install',
      'yarn up',
      'yarn upgrade',
      'cargo add',
      'cargo remove',
      'cargo update',
    ],
    // Each copy has its own manifests, lockfile and node_modules; a clash is settled at merge.
    scope: HazardScope.Copy,
  },
  {
    name: 'harness',
    globs: ['AGENTS.md', '**/AGENTS.md', '.claude/**', '.codex/**'],
    commands: [],
    // Files each copy has its own version of.
    scope: HazardScope.Copy,
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

/**
 * The area and hazard names whose tasks are proposed a separate copy unless a project says
 * otherwise: the stock hazards every project has. A project adds its own, such as `contracts`.
 */
export const DEFAULT_ISOLATE = ['migrations', 'deps'] as const;

/** Area and hazard names, not globs; a name the project doesn't define yet matches no task. */
const Isolate = z.array(Name).max(64);

const UsageHandoffAt = z.number().min(USAGE_HANDOFF_MIN).max(USAGE_HANDOFF_MAX);

/** The refusal for a default landing in a branch that is not named. */
export const NAME_LANDING_BRANCH = 'Name the branch new tasks land in';

export const ProjectInput = z
  .object({
    name: z.string().min(1),
    repoPath: z.string().startsWith('/'),
    /** The command that checks a task's work; null means the builder checks each finished task. */
    gateCommand: z.string().min(1).nullable().default(null),
    /**
     * The command that checks only what a task's diff touched. 10db runs it after each implement
     * step instead of the gate command; the ship gate still runs the gate command. Null keeps the
     * gate command for both.
     */
    changedCheckCommand: z.string().min(1).nullable().default(null),
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
    /** What a finished task's pull request does unless the task says otherwise. */
    landing: z.enum(ProjectLanding).default(DEFAULT_PROJECT_LANDING),
    /** The branch of origin new tasks land in when `landing` is `branch`; null otherwise. */
    landingBranch: BranchName.nullable().default(null),
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
    /**
     * Where a new task works unless it says otherwise: the one checkout, or a git worktree of its
     * own (pull request delivery only).
     */
    workspaceMode: z.enum(WorkspaceMode).default(WorkspaceMode.Shared),
    /** Ignored directories of the main checkout a new worktree gets copies of. */
    worktreeSeed: WorktreeSeed.default(() => [...DEFAULT_WORKTREE_SEED]),
    /** Area and hazard names whose tasks are proposed a separate copy. */
    isolate: Isolate.default(() => [...DEFAULT_ISOLATE]),
  })
  .refine((p) => p.nudgePct > p.handoffPct, {
    message: 'nudgePct must be above handoffPct',
    path: ['nudgePct'],
  })
  .refine((p) => p.landing !== ProjectLanding.Branch || p.landingBranch !== null, {
    message: NAME_LANDING_BRANCH,
    path: ['landingBranch'],
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
  gateCommand: z.string().nullable(),
  changedCheckCommand: z.string().nullable(),
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
  landing: z.enum(ProjectLanding),
  landingBranch: z.string().nullable(),
  prTitlePrefix: z.string().nullable(),
  allowedCommands: z.array(z.string()),
  sandboxLoopback: z.boolean(),
  /**
   * The placement a new task gets unless it names one or its areas propose a copy; changing it
   * moves no existing task. Each task's own placement is `TaskDto.workspaceMode`.
   */
  workspaceMode: z.enum(WorkspaceMode),
  worktreeSeed: z.array(z.string()),
  /** Area and hazard names whose tasks are proposed a separate copy. */
  isolate: z.array(z.string()),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ProjectDto = z.infer<typeof ProjectDto>;

/** Fields the builder can change after creation; the nudge/handoff rule is checked against the merged values. */
export const ProjectPatch = z
  .object({
    name: z.string().min(1),
    gateCommand: z.string().min(1).nullable(),
    changedCheckCommand: z.string().min(1).nullable(),
    maxLanes: z.int().min(1).max(16),
    handoffPct: z.int().min(5).max(95),
    nudgePct: z.int().min(6).max(98),
    humanWaitMinutes: z.int().min(1).max(240),
    flowId: FlowId.nullable(),
    /** The most a task may cost, in USD, compared with a profile's AA cost per task; null for no ceiling. */
    budgetCeiling: z.number().positive().nullable(),
    delivery: z.enum(Delivery),
    baseBranch: BranchName,
    landing: z.enum(ProjectLanding),
    /** The branch new tasks land in when `landing` is `branch`; a `landing` that is not `branch` forgets it. */
    landingBranch: BranchName.nullable(),
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
    /** The default for new tasks; it can change while work runs, and moves no existing task. */
    workspaceMode: z.enum(WorkspaceMode),
    worktreeSeed: WorktreeSeed,
    isolate: Isolate,
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
  /** Where the work lands; absent starts from what the project does by default. */
  landing: TaskLanding.optional(),
  /** Where the task works; absent takes the project's default. A copy needs pull request delivery. */
  workspaceMode: z.enum(WorkspaceMode).optional(),
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
  landing: TaskLanding,
  /**
   * Where the task runs when it is next started: the project's checkout (`shared`, "Your folder")
   * or a git worktree of its own (`worktree`, "Separate copy"). Meaningful only while the task can
   * be started; after that its batch says where it ran.
   */
  workspaceMode: z.enum(WorkspaceMode),
  /** Why the placement was proposed ("touches migrations"); null when it was chosen or defaulted. */
  placementReason: z.string().nullable(),
  status: z.enum(TaskStatus),
  boardOrder: z.number(),
  boardColumnId: BoardColumnId.nullable(),
  dependsOn: z.array(TaskId),
  boardStatus: z.enum(BoardStatus),
  workstreamId: WorkstreamId.nullable(),
  /** The goal the task belongs to; absent or null for a task on its own. */
  goalId: GoalId.nullable().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TaskDto = z.infer<typeof TaskDto>;

/** The fields of a task the builder can change; each is optional in a patch. */
export const TaskPatchFields = z.object({
  title: Title,
  description: z.string(),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  riskTags: z.array(z.enum(RiskTag)),
  flowId: FlowId.nullable(),
});

/**
 * `workspaceMode` changes only while the task could be started (it is open and its latest run is
 * not active), and only in a project that delivers by pull request.
 */
export const TaskPatch = TaskPatchFields.extend({
  landing: TaskLanding,
  workspaceMode: z.enum(WorkspaceMode),
})
  .partial()
  .refine((p) => Object.keys(p).length > 0, {
    message: 'Change at least one field',
  });
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
  /** The work is done and the project has no gate: the builder approves it or sends it back. */
  z.object({ kind: z.literal('builder_review'), inboxId: InboxItemId }),
]);
export type NextAction = z.infer<typeof NextAction>;

/** The longest `Notice.line`: one line on a task's card. */
export const NOTICE_LINE_MAX = 500;
/** The longest `Notice.body`, shown in the drawer. */
export const NOTICE_BODY_MAX = 8000;

/**
 * Something a task's card and drawer say about the task or its batch that asks the builder nothing:
 * 10db is waiting for another task's claim, or the batch's branch can't take its base yet. It stands
 * until its cause is gone and raises no Inbox card (`decisions/2026-10-31-notices-not-cards.md`).
 */
export const Notice = z.object({
  /** What the notice is about; a later notice with the same key in the same place replaces it. */
  key: z.string().min(1).max(200),
  /** `warning` is something the builder may need to act on, `info` is 10db waiting on its own. */
  tone: z.enum(['info', 'warning']),
  /** The one line a task's card shows. */
  line: z.string().min(1).max(NOTICE_LINE_MAX),
  /** What the drawer shows under the line: who, why, and what to do about it. */
  body: z.string().max(NOTICE_BODY_MAX),
});
export type Notice = z.infer<typeof Notice>;

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The notice cut to what `Notice` allows, ending in an ellipsis where it was cut: a gh error or a long
 * list of paths must not make the batch or run that holds it fail to parse.
 */
export function fitNotice(notice: Notice): Notice {
  return {
    ...notice,
    line: cut(notice.line, NOTICE_LINE_MAX),
    body: cut(notice.body, NOTICE_BODY_MAX),
  };
}

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
  /** When the builder put it first in line; null for a workstream that waits in the order it started. */
  runNextAt: Timestamp.nullable(),
  /** What the run is waiting for or held by besides the builder, such as another task's hazard claim. */
  notice: Notice.nullable().default(null),
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

/** `POST /workstreams/:id/retry`: the builder's note, for the session a retry sends the work to. */
export const RetryInput = z.object({ note: z.string().max(4000).optional() });
export type RetryInput = z.infer<typeof RetryInput>;

/** The two answers to a check card: the work is right, or it goes back with a note. */
export const CheckChoice = {
  Approve: 'approve',
  SendBack: 'send_back',
} as const;
export type CheckChoice = (typeof CheckChoice)[keyof typeof CheckChoice];

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
  /** The project file whose scan allowed the host (such as `Cargo.lock`); null for any other source. */
  foundIn: z.string().nullable(),
  createdAt: Timestamp,
});
export type PermissionRuleDto = z.infer<typeof PermissionRuleDto>;

/** Where an allowed host came from: a project file's scan, an Inbox card's Allow, or the builder typing it. */
export const NetworkHostSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), file: z.string() }),
  z.object({ kind: z.literal('card') }),
  z.object({ kind: z.literal('builder') }),
]);
export type NetworkHostSource = z.infer<typeof NetworkHostSource>;

/** A host the builder allows a project's sessions and checks to reach: its project-wide network rule. */
export const NetworkHostDto = z.object({
  host: z.string(),
  source: NetworkHostSource,
  createdAt: Timestamp,
});
export type NetworkHostDto = z.infer<typeof NetworkHostDto>;

/** A host a project's package files name, and the file that names it (its path from the project root). */
export const FoundHostDto = z.object({ host: z.string(), file: z.string() });
export type FoundHostDto = z.infer<typeof FoundHostDto>;

/** What the builder types to allow a host; the daemon judges it and answers a refusal in words. */
export const NetworkHostInput = z.object({ host: z.string() });
export type NetworkHostInput = z.infer<typeof NetworkHostInput>;

const EvidenceBase = {
  id: EvidenceId,
  workstreamId: WorkstreamId,
  summary: z.string(),
  logPath: z.string().nullable(),
  commitShas: z.array(z.string()),
  createdAt: Timestamp,
};

/** What a check left behind: a gate's or agent's command and exit code, or the builder's note. */
export const EvidenceDto = z.discriminatedUnion('kind', [
  z.object({
    ...EvidenceBase,
    kind: z.literal(EvidenceKind.Gate),
    command: z.string(),
    exitCode: z.int(),
  }),
  z.object({
    ...EvidenceBase,
    kind: z.literal(EvidenceKind.Agent),
    command: z.string(),
    exitCode: z.int(),
  }),
  z.object({
    ...EvidenceBase,
    kind: z.literal(EvidenceKind.Builder),
    command: z.null(),
    exitCode: z.null(),
  }),
]);
export type EvidenceDto = z.infer<typeof EvidenceDto>;
