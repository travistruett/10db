import { z } from 'zod';
import { USAGE_HANDOFF_AT, USAGE_HANDOFF_MAX, USAGE_HANDOFF_MIN } from './accounts';
import { AllowedCommands } from './allowed-commands';
import { ModelSetting } from './catalogue';
import { BranchName, PrTitlePrefix } from './git-names';
import { AreaRole, AreaRoute, areaRolesProblem } from './page-areas';
import { ScreensMatrix } from './task-screens';
import {
  AccountId,
  BatchId,
  BoardColumnId,
  EvidenceId,
  FlowId,
  GoalId,
  HandoffId,
  InboxItemId,
  LandingGroupId,
  PassId,
  PersonId,
  PermissionRuleId,
  ProjectId,
  SessionId,
  TaskId,
  TaskMessageId,
  WorkstreamId,
} from './ids';
import {
  BoardStatus,
  Delivery,
  Effort,
  EvidenceKind,
  InboxKind,
  InboxState,
  KnowledgeScope,
  Provider,
  QuestionCategory,
  RiskTag,
  RoutedBy,
  TaskStatus,
  Urgency,
  WorkspaceMode,
  WorkstreamState,
} from './states';
import { DEFAULT_PROJECT_LANDING, ProjectLanding, TaskLanding } from './landing';
import { StakeholderSendDto } from './slack';
import { WorkstreamStep } from './steps';

const Name = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and hyphens');

/** An area's name, as a project's area vocabulary spells it. */
export const AreaName = Name;
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

/** The longest task headline: a few plain words the desktop names the task by. */
export const HEADLINE_MAX = 80;
/** The longest task why: one sentence. */
export const WHY_MAX = 200;

/** One line of at most `max` characters, empty allowed; each refusal names the field. */
function oneLine(field: string, max: number) {
  return z
    .string()
    .max(max, `The ${field} is at most ${String(max)} characters`)
    .refine(
      (t) => !CONTROL_CHARACTER.test(t),
      `The ${field} is one line, with no control characters such as newlines or tabs`,
    );
}

/**
 * A task's headline: the plain-words what ("Odd files can't freeze 10db"). Empty means none, and the
 * desktop shows the title instead. Git never sees it; the title stays the pull request's.
 */
export const Headline = oneLine('headline', HEADLINE_MAX);
/** Why a task matters, in one sentence; empty means none. */
export const Why = oneLine('why', WHY_MAX);

const GlobbedDef = z.object({ name: Name, globs: z.array(z.string().min(1)).min(1) });

/**
 * An area: the files its globs match. `catchAll` makes it the project's fallback, as CODEOWNERS
 * falls back to its widest rule: a path no other area matches falls in it, so a file added later
 * (a new package, a first dotfile) is in an area. A path another area matches is never in it. A
 * project has at most one (`atMostOneCatchAll`); absent or false is an ordinary area.
 *
 * `role` says whether the area is a page of the project's app or code pages share; absent, the area
 * behaves as it always has. `route` is the path that shows a page, on a page only. Two pages may not
 * share a file (`areaRolesProblem`, checked on create and on patch).
 */
export const AreaDef = GlobbedDef.extend({
  catchAll: z.boolean().optional(),
  role: z.enum(AreaRole).optional(),
  route: AreaRoute.optional(),
});
export type AreaDef = z.infer<typeof AreaDef>;

/** The refusal for a project with two catch-all areas. */
export const ONE_CATCH_ALL = 'Only one area can be the catch-all';

/** Whether at most one of `areas` is the catch-all. */
export function atMostOneCatchAll(
  areas: readonly Pick<AreaDef, 'catchAll'>[] | undefined,
): boolean {
  return (areas ?? []).filter((a) => a.catchAll === true).length <= 1;
}

/** Adds the areas' role and route problem, if any, to a project being parsed. */
function checkAreaRoles(areas: readonly AreaDef[] | undefined, ctx: z.RefinementCtx): void {
  const problem = areaRolesProblem(areas ?? []);
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem, path: ['areas'] });
}

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
export const HazardDef = GlobbedDef.extend({
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
    globs: [
      '**/migrations/**',
      '**/drizzle/**',
      '**/alembic/versions/**',
      '**/db/migrate/**',
      '**/prisma/migrations/**',
    ],
    commands: [
      'drizzle-kit generate',
      'pnpm db:migrate',
      'npm db:migrate',
      'yarn db:migrate',
      // Django. `manage.py` is the script `./manage.py` and `python manage.py` run.
      'manage.py makemigrations',
      'manage.py migrate',
      'manage.py squashmigrations',
      'python manage.py makemigrations',
      'python manage.py migrate',
      'python manage.py squashmigrations',
      'python3 manage.py makemigrations',
      'python3 manage.py migrate',
      'python3 manage.py squashmigrations',
      'django-admin makemigrations',
      'django-admin migrate',
      // Alembic.
      'alembic revision',
      'alembic upgrade',
      'alembic downgrade',
      // Rails.
      'rails generate migration',
      'rails g migration',
      'rails db:migrate',
      'rails db:rollback',
      'rake db:migrate',
      'rake db:rollback',
      // Prisma.
      'prisma migrate dev',
      'prisma migrate deploy',
      'prisma migrate reset',
      'prisma db push',
    ],
    // The migrations run against a database every copy shares.
    scope: HazardScope.Project,
  },
  {
    name: 'deps',
    globs: [
      '**/package.json',
      '**/package-lock.json',
      '**/npm-shrinkwrap.json',
      'pnpm-lock.yaml',
      '**/pnpm-lock.yaml',
      '**/yarn.lock',
      '**/bun.lock',
      '**/bun.lockb',
      '**/Cargo.toml',
      '**/Cargo.lock',
      '**/pyproject.toml',
      '**/uv.lock',
      '**/poetry.lock',
      '**/requirements*.txt',
      '**/requirements/*.txt',
      '**/Pipfile',
      '**/Pipfile.lock',
      '**/go.mod',
      '**/go.sum',
      '**/Gemfile',
      '**/Gemfile.lock',
    ],
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
      'npm install-test',
      'npm update',
      'npm un',
      'yarn add',
      'yarn remove',
      'yarn install',
      'yarn up',
      'yarn upgrade',
      'cargo add',
      'cargo remove',
      'cargo update',
      // uv.
      'uv add',
      'uv remove',
      'uv lock',
      'uv sync',
      'uv pip install',
      'uv pip uninstall',
      'uv pip sync',
      'uv pip compile',
      // Poetry.
      'poetry add',
      'poetry remove',
      'poetry lock',
      'poetry install',
      'poetry update',
      'poetry sync',
      // pip, Pipenv and pip-tools.
      'pip install',
      'pip uninstall',
      'pip3 install',
      'pip3 uninstall',
      'pipenv install',
      'pipenv uninstall',
      'pipenv update',
      'pipenv lock',
      'pip-compile',
      'pip-sync',
      // Go modules.
      'go get',
      'go mod tidy',
      'go mod download',
      'go mod vendor',
      'go mod edit',
      // Bundler.
      'bundle add',
      'bundle remove',
      'bundle install',
      'bundle update',
      'bundle lock',
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

/**
 * The commands each release added to the stock hazards after the first, oldest first, keyed by
 * hazard name. A project keeps the hazard list it was added with, so 10db adds each revision it has
 * not yet applied to the stored hazard of that name once (`addStockHazardCommands` in @10db/db);
 * a command the builder removes after that stays removed. A command added to `DEFAULT_HAZARDS`
 * goes in a new revision at the end, never in an old one.
 */
export interface StockHazardRevision {
  /** The commands the release added, keyed by hazard name. */
  readonly commands?: Readonly<Record<string, readonly string[]>>;
  /** The globs the release added, keyed by hazard name. */
  readonly globs?: Readonly<Record<string, readonly string[]>>;
}

export const STOCK_HAZARD_REVISIONS: readonly StockHazardRevision[] = [
  // #108, 2026-10-28.
  {
    commands: {
      deps: [
        'pnpm uninstall',
        'pnpm un',
        'pnpm upgrade',
        'npm add',
        'npm ci',
        'npm un',
        'yarn add',
        'cargo update',
      ],
    },
  },
  // #202, 2026-10-31.
  {
    commands: {
      migrations: ['npm db:migrate', 'yarn db:migrate'],
      deps: [
        'pnpm it',
        'pnpm ci',
        'pnpm install-test',
        'pnpm clean-install',
        'bun add',
        'bun remove',
        'bun install',
        'bun i',
        'bun update',
        'npm install-test',
        'npm update',
        'yarn remove',
        'yarn install',
        'yarn up',
        'yarn upgrade',
      ],
    },
  },
  // Lockfiles and migrations of the Python, Go and Ruby stacks, at any depth, 2026-11-08.
  {
    globs: {
      migrations: ['**/alembic/versions/**', '**/db/migrate/**', '**/prisma/migrations/**'],
      deps: [
        '**/package-lock.json',
        '**/npm-shrinkwrap.json',
        '**/pnpm-lock.yaml',
        '**/yarn.lock',
        '**/bun.lock',
        '**/bun.lockb',
        '**/pyproject.toml',
        '**/uv.lock',
        '**/poetry.lock',
        '**/requirements*.txt',
        '**/requirements/*.txt',
        '**/Pipfile',
        '**/Pipfile.lock',
        '**/go.mod',
        '**/go.sum',
        '**/Gemfile',
        '**/Gemfile.lock',
      ],
    },
    commands: {
      migrations: [
        'manage.py makemigrations',
        'manage.py migrate',
        'manage.py squashmigrations',
        'python manage.py makemigrations',
        'python manage.py migrate',
        'python manage.py squashmigrations',
        'python3 manage.py makemigrations',
        'python3 manage.py migrate',
        'python3 manage.py squashmigrations',
        'django-admin makemigrations',
        'django-admin migrate',
        'alembic revision',
        'alembic upgrade',
        'alembic downgrade',
        'rails generate migration',
        'rails g migration',
        'rails db:migrate',
        'rails db:rollback',
        'rake db:migrate',
        'rake db:rollback',
        'prisma migrate dev',
        'prisma migrate deploy',
        'prisma migrate reset',
        'prisma db push',
      ],
      deps: [
        'uv add',
        'uv remove',
        'uv lock',
        'uv sync',
        'uv pip install',
        'uv pip uninstall',
        'uv pip sync',
        'uv pip compile',
        'poetry add',
        'poetry remove',
        'poetry lock',
        'poetry install',
        'poetry update',
        'poetry sync',
        'pip install',
        'pip uninstall',
        'pip3 install',
        'pip3 uninstall',
        'pipenv install',
        'pipenv uninstall',
        'pipenv update',
        'pipenv lock',
        'pip-compile',
        'pip-sync',
        'go get',
        'go mod tidy',
        'go mod download',
        'go mod vendor',
        'go mod edit',
        'bundle add',
        'bundle remove',
        'bundle install',
        'bundle update',
        'bundle lock',
      ],
    },
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

/**
 * The refusal for a pre-check on a project with no gate command, and for clearing the gate command
 * while a pre-check is set: a project without a gate command runs nothing.
 */
export const PRECHECK_NEEDS_GATE = 'A pre-check needs a gate command: set a gate command first';

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
    /**
     * The command that runs on the Mac in place of the gate when the pull request's base branch has
     * required checks on GitHub (CI-decides spec §3). Null keeps running the gate. Refused without
     * a gate command.
     */
    precheckCommand: z.string().min(1).nullable().default(null),
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
    /**
     * A pass's pull request shows each signed-off page's before and after pictures, pushed to a
     * `10db-pictures/<pass>` branch of origin. Off by default: a picture can show the app's own data.
     */
    prPictures: z.boolean().default(false),
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
     * Gives the project's gate and lane commands the Docker socket. Docker can mount any host folder
     * into a container, so a command with it can reach outside the sandbox. Off for a new project;
     * 10db turns it on itself when the project is seen to need Docker.
     */
    sandboxDocker: z.boolean().default(false),
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
  .refine((p) => p.precheckCommand === null || p.gateCommand !== null, {
    message: PRECHECK_NEEDS_GATE,
    path: ['precheckCommand'],
  })
  .refine((p) => atMostOneCatchAll(p.areas), { message: ONE_CATCH_ALL, path: ['areas'] })
  .superRefine((p, ctx) => {
    checkAreaRoles(p.areas, ctx);
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

/** The loopback hosts a project's app address may name: this Mac, never another machine. */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Whether `raw` is exactly an `http` or `https` origin on a loopback host (`localhost`, a name under
 * `.localhost`, `127.0.0.1` or `[::1]`), any port: no path, no query, no credentials, written as the
 * browser writes the origin.
 */
export function isLoopbackOrigin(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.origin === raw &&
    (LOOPBACK_HOSTS.includes(url.hostname) || url.hostname.endsWith('.localhost'))
  );
}

/** Where the builder's dev server answers (Workbench spec §10): a loopback origin only. */
export const AppUrl = z
  .string()
  .refine(
    isLoopbackOrigin,
    'An app address is an http origin on this Mac, such as http://localhost:8800',
  );
export type AppUrl = z.infer<typeof AppUrl>;

/** Said when an app address names the daemon's own port: a page loaded there would reach 10db's API. */
export const APP_URL_IS_DAEMON =
  "That is 10db's own address: an app address names your dev server's port";

/**
 * Whether the app address is on the port the daemon listens on. Every app address is a loopback
 * origin, so its port alone says it would reach the daemon's API.
 */
export function isDaemonAddress(appUrl: AppUrl, daemonPort: number): boolean {
  const url = new URL(appUrl);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  return port === daemonPort;
}

/** A command the builder types for the project, such as its dev login; a blank one is no command. */
const ProjectCommand = z
  .string()
  .max(2000)
  .transform((c) => (c.trim() === '' ? null : c));

export const ProjectDto = z.object({
  id: ProjectId,
  name: z.string(),
  repoPath: z.string(),
  gateCommand: z.string().nullable(),
  changedCheckCommand: z.string().nullable(),
  /** Runs in place of the gate when the base has required checks; null keeps the gate. */
  precheckCommand: z.string().nullable(),
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
  /**
   * The move was caused by a usage limit, so 10db moves the project back by itself once the limit has
   * reset. False for a move the builder made by hand: 10db then asks.
   */
  moveBackAutomatic: z.boolean(),
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
  prPictures: z.boolean(),
  allowedCommands: z.array(z.string()),
  sandboxLoopback: z.boolean(),
  sandboxDocker: z.boolean(),
  /**
   * True once the builder has set `sandboxDocker` by hand to off: 10db then never turns it on by
   * itself. Setting it on by hand clears this.
   */
  sandboxDockerOptOut: z.boolean(),
  /**
   * The placement a new task gets unless it names one or its areas propose a copy; changing it
   * moves no existing task. Each task's own placement is `TaskDto.workspaceMode`.
   */
  workspaceMode: z.enum(WorkspaceMode),
  worktreeSeed: z.array(z.string()),
  /** Area and hazard names whose tasks are proposed a separate copy. */
  isolate: z.array(z.string()),
  /** Where the builder's dev server answers; null when the project has not said. */
  appUrl: AppUrl.nullable(),
  /** Prints a URL or path on the app's address that signs a browser in; null when the app needs none. */
  devLoginCommand: z.string().nullable(),
  /**
   * Serves the app at its address while a UI Workbench pass is open, run by 10db under the gate's
   * sandbox in the project's folder; null when the builder runs the dev server.
   */
  previewCommand: z.string().nullable(),
  /** The viewports and themes each page's pictures are taken in. */
  screens: ScreensMatrix,
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
    /** Refused while the project (after this patch) has no gate command. */
    precheckCommand: z.string().min(1).nullable(),
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
    prPictures: z.boolean(),
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
    /** Setting it off records the builder's choice, which 10db's own turning on never overrides. */
    sandboxDocker: z.boolean(),
    /** The default for new tasks; it can change while work runs, and moves no existing task. */
    workspaceMode: z.enum(WorkspaceMode),
    worktreeSeed: WorktreeSeed,
    isolate: Isolate,
    /** Where Open Page goes; null forgets it. */
    appUrl: AppUrl.nullable(),
    /** Run under the gate's sandbox before pictures; blank or null forgets it. */
    devLoginCommand: ProjectCommand.nullable(),
    /** Run under the gate's sandbox while a pass is open; blank or null forgets it. */
    previewCommand: ProjectCommand.nullable(),
    screens: ScreensMatrix,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' })
  .refine((p) => atMostOneCatchAll(p.areas), { message: ONE_CATCH_ALL, path: ['areas'] })
  .superRefine((p, ctx) => {
    checkAreaRoles(p.areas, ctx);
  })
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
  headline: Headline.default(''),
  why: Why.default(''),
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
  /** The precise promise; the source of the batch, pull request and commit titles. */
  title: z.string(),
  /** The plain-words what; empty when none was written, and the desktop shows the title. */
  headline: z.string(),
  /** One sentence on why the task matters; empty when none was written. */
  why: z.string(),
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
  /**
   * The landing the task belongs to (Shape spec §10.4): tasks that share one start into one batch,
   * so one pull request. Absent or null for a task that lands alone.
   */
  landingGroupId: LandingGroupId.nullable().optional(),
  /** The Workbench pass the task is in; absent or null for a task outside every pass. */
  passId: PassId.nullable().optional(),
  /**
   * Whether the task holds work saved from a Workbench pass it was taken out of, which its next start
   * puts back; absent or false for none.
   */
  keptWork: z.boolean().optional(),
  /** The builder's own model setting for this task; null is no override, and Automatic is a setting. */
  modelSetting: ModelSetting.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TaskDto = z.infer<typeof TaskDto>;

/** The fields of a task the builder can change; each is optional in a patch. */
export const TaskPatchFields = z.object({
  title: Title,
  /** An empty string clears it. */
  headline: Headline,
  /** An empty string clears it. */
  why: Why,
  description: z.string(),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  riskTags: z.array(z.enum(RiskTag)),
  flowId: FlowId.nullable(),
  /** Replaces the task's areas; only while the task has never started, and only with the project's own. */
  areas: z.array(Name).min(1),
});

/**
 * `workspaceMode` changes only while the task could be started (it is open and its latest run is
 * not active), and only in a project that delivers by pull request.
 */
export const TaskPatch = TaskPatchFields.extend({
  landing: TaskLanding,
  workspaceMode: z.enum(WorkspaceMode),
  /** Null removes the task's override. */
  modelSetting: ModelSetting.nullable(),
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
  /**
   * A builder message from the task's thread to act on: the provider session is resumed and handed
   * it, or, with none, a fresh session starts from the thread's digest and then the message.
   */
  z.object({
    kind: z.literal('feedback'),
    messageId: TaskMessageId,
    providerSessionId: z.string().min(1).nullable(),
  }),
  /** The step ended with these changes in its claims uncommitted; the next session commits them. */
  z.object({ kind: z.literal('uncommitted'), paths: z.array(z.string().min(1)).min(1) }),
  /**
   * 10db merged the batch's base into the branch and git left conflict markers in these files; the
   * next session resolves them and commits, and 10db runs the gate on the merged branch.
   */
  z.object({
    kind: z.literal('merge'),
    base: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
  }),
  z.object({ kind: z.literal('verify') }),
  /** Rerun a step a reviewer rejected; the rejecting step's notes are in its result. */
  z.object({ kind: z.literal('revise'), reviewStep: z.int().min(0) }),
  /** The work is done and the project has no gate: the builder approves it or sends it back. */
  z.object({ kind: z.literal('builder_review'), inboxId: InboxItemId }),
  /**
   * A page of a Workbench pass is Ready, or its turn failed: the builder looks at it and writes again
   * or signs it off. `inboxId` names the Ready `check` item or the failed turn's `flag`.
   */
  z.object({ kind: z.literal('pass_review'), inboxId: InboxItemId }),
]);
export type NextAction = z.infer<typeof NextAction>;

/** What kind of next action a workstream has, without its fields. */
export const NextActionKind = z.enum(NextAction.options.map((o) => o.shape.kind.value));
export type NextActionKind = z.infer<typeof NextActionKind>;

/** The longest `Notice.line`: one line on a task's card. */
export const NOTICE_LINE_MAX = 500;
/** The longest `Notice.body`, shown in the drawer. */
export const NOTICE_BODY_MAX = 8000;
/** The longest `Notice.record`: what 10db keeps with a notice for itself, never shown. */
export const NOTICE_RECORD_MAX = 100_000;

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
  /**
   * What 10db keeps with the notice to read back after a restart (JSON, say). It is not display text:
   * no card or drawer shows it, and `fitNotice` never cuts it into something that no longer parses.
   */
  record: z.string().max(NOTICE_RECORD_MAX).optional(),
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
  const { record, ...shown } = notice;
  return {
    ...shown,
    line: cut(notice.line, NOTICE_LINE_MAX),
    body: cut(notice.body, NOTICE_BODY_MAX),
    // A cut record would no longer parse and could read as another one: a record too long is left off.
    ...(record !== undefined && record.length <= NOTICE_RECORD_MAX ? { record } : {}),
  };
}

export const WorkstreamDto = z.object({
  id: WorkstreamId,
  taskId: TaskId,
  taskTitle: z.string(),
  /** The task's headline; empty when it has none, and the desktop shows `taskTitle`. */
  taskHeadline: z.string(),
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
  /**
   * What kind of failure `failureReason` describes; null when it has not failed or failed before kinds were kept.
   * Any string parses: a kind from a newer daemon must not fail the whole workstream list, and the desktop
   * gives a kind it doesn't know the generic line. The daemon only writes a `WorkstreamFailure`.
   */
  failureKind: z.string().nullable().default(null),
  lastActivityAt: Timestamp.nullable(),
  /** When the builder put it first in line; null for a workstream that waits in the order it started. */
  runNextAt: Timestamp.nullable(),
  /** What the run is waiting for or held by besides the builder, such as another task's hazard claim. */
  notice: Notice.nullable().default(null),
  /**
   * Whether a note told this run's session that its commits were reverted by Ship without it (a Retry
   * or a start that joined the batch wrote it), and that revert still stands: false once Ship without
   * it finds none on the branch. The notice slot can't say so: a joined run holds none, and a wait can
   * replace one. The failure line reads it to say where Retry restarts the run.
   */
  revertTold: z.boolean().default(false),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type WorkstreamDto = z.infer<typeof WorkstreamDto>;

export const InboxOption = z.object({ label: z.string().min(1).max(80), description: z.string() });
export type InboxOption = z.infer<typeof InboxOption>;

/** Recording an answer as a decision at a target; an area scope names its area, any other scope none. */
export const DecisionRecording = z
  .object({ scope: z.enum(KnowledgeScope), area: AreaName.nullable() })
  .refine((r) => (r.scope === KnowledgeScope.Area) === (r.area !== null), {
    message: 'area is required for scope "area" and only allowed there',
    path: ['area'],
  });
export type DecisionRecording = z.infer<typeof DecisionRecording>;

export const InboxAnswer = z.object({
  choice: z.string().min(1),
  note: z.string().max(4000).optional(),
  /**
   * Omitted: a product, design or engineering question is recorded as a project decision (spec §7).
   * Null: not recorded. A recording: recorded at that target, whatever the question's category.
   */
  record: DecisionRecording.nullable().optional(),
});
export type InboxAnswer = z.infer<typeof InboxAnswer>;

/**
 * An answer as stored. The extra keys are written by the daemon only; `InboxAnswer`, the HTTP body,
 * drops them, so a client cannot answer as someone else.
 */
export const RecordedAnswer = InboxAnswer.extend({
  answeredBy: z.string().optional(),
  via: z.enum(['inbox', 'slack']).optional(),
  /** The answerer's own words, when they chose none of the options. */
  words: z.string().max(20000).optional(),
  /** Others in the conversation who agreed, by handle. */
  with: z.array(z.string()).optional(),
});
export type RecordedAnswer = z.infer<typeof RecordedAnswer>;

/** `POST /workstreams/:id/retry`: the builder's note, for the session a retry sends the work to. */
export const RetryInput = z.object({ note: z.string().max(4000).optional() });
export type RetryInput = z.infer<typeof RetryInput>;

/**
 * `POST /tasks/:id/start`: `fresh` starts a task whose latest run failed in an open batch over from
 * the base branch; without it the run continues in that batch, as the failure card's Retry does.
 */
export const StartTaskInput = z.object({ fresh: z.boolean().optional() });
export type StartTaskInput = z.infer<typeof StartTaskInput>;

/** The two answers to a check card: the work is right, or it goes back with a note. */
export const CheckChoice = {
  Approve: 'approve',
  SendBack: 'send_back',
} as const;
export type CheckChoice = (typeof CheckChoice)[keyof typeof CheckChoice];

/**
 * The choice every lane question card offers beside the lane's own: answering it stops the run and
 * parks the task in the project's Icebox column, with the question and the answer on its drawer. The
 * daemon adds it to every question, whatever options the lane wrote.
 */
export const PARK_TASK_CHOICE = 'Park the task';

/** The park option as a card shows it. */
export const PARK_TASK_OPTION: InboxOption = {
  label: PARK_TASK_CHOICE,
  description:
    'Stops this run and parks the task in the Icebox, with this question and your answer on its drawer. No review follows; start it again when you can answer.',
};

/** Whether `choice` is the park choice, however the card's text was cased or spaced. */
export function isParkChoice(choice: string): boolean {
  return choice.trim().replace(/\s+/g, ' ').toLowerCase() === PARK_TASK_CHOICE.toLowerCase();
}

/** The options with the park choice last, unless the lane already wrote it. */
export function withParkOption(options: readonly InboxOption[]): InboxOption[] {
  return options.some((o) => isParkChoice(o.label)) ? [...options] : [...options, PARK_TASK_OPTION];
}

const MANY_TASKS_PARK_PREFIX = 'Stops these ';

/**
 * The options with the park option worded for the tasks it parks. A card several lanes raised parks
 * every one of them, so with more than one task the option names them before the builder answers.
 * With one (or none) the option has its plain wording again, when this function had reworded it. A
 * park option the lane wrote is reworded for several tasks too, since the builder needs the names.
 */
export function withParkedTasks(
  options: readonly InboxOption[],
  taskTitles: readonly string[],
): InboxOption[] {
  if (taskTitles.length < 2) {
    return options.map((o) =>
      isParkChoice(o.label) && o.description.startsWith(MANY_TASKS_PARK_PREFIX)
        ? { ...o, description: PARK_TASK_OPTION.description }
        : o,
    );
  }
  const description = `${MANY_TASKS_PARK_PREFIX}${String(taskTitles.length)} runs and parks their tasks in the Icebox: ${taskTitles
    .map((t) => `“${t}”`)
    .join(
      ', ',
    )}. This question and your answer go on each drawer. No review follows; start them again when you can answer.`;
  return options.map((o) => (isParkChoice(o.label) ? { ...o, description } : o));
}

/** The key of the notice a parked run keeps for its task's drawer: the question and the builder's answer. */
export const PARKED_NOTICE_KEY = 'parked-answer';

/**
 * The key of the notice a failed run keeps once its batch shipped without it (Ship without it): its
 * task's drawer says the run was left out of the pull request. Like a parked run's, it records what
 * the builder chose, not a wait, so a daemon start keeps it.
 */
export const LEFT_OUT_NOTICE_KEY = 'left-out';

/**
 * The key of the notice a retried run keeps while its commits stay reverted on the batch's branch
 * (Retry after Ship without it). The pull request lists the run's task as done only when it
 * committed again after the revert.
 */
export const REVERTED_NOTICE_KEY = 'reverted-work';

/** The start of the line on which these notices, and a retried run's note, name the revert commit. */
export const REVERT_COMMIT_LINE = 'Revert commit: ';

/** The full id of the revert commit a text names on its revert line; null when it names none. */
export function revertCommitIn(text: string): string | null {
  const line = text.split('\n').find((l) => l.startsWith(REVERT_COMMIT_LINE));
  const sha = line?.slice(REVERT_COMMIT_LINE.length).trim() ?? '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * The revert commit a run's latest builder note told its session about, read from the run's evidence
 * oldest first. Null when none did, or when a `no_revert` record came after: a Retry wrote that because
 * the revert had left the branch. The notice shares one slot with the run's waits, so a wait can
 * replace it; the notes are what lasts.
 */
export function lastRevertTold(
  evidence: readonly { readonly kind: string; readonly summary: string }[],
): string | null {
  let found: string | null = null;
  for (const row of evidence) {
    if (row.kind === EvidenceKind.NoRevert) found = null;
    else if (row.kind === EvidenceKind.Builder) found = revertCommitIn(row.summary) ?? found;
  }
  return found;
}

/**
 * The key of the batch notice that records 10db repaired a broken install by itself. It is history,
 * not a wait: a task's drawer keeps showing it after its run fails or its batch ends.
 */
export const INSTALL_REPAIRED_NOTICE_KEY = 'install-repaired';

/**
 * The key of the batch notice that lists the migrations a merge of the base renumbered. Every later
 * step of the batch is briefed from it, because docs that name those migrations are the lane's to fix.
 */
export const MIGRATIONS_RENUMBERED_NOTICE_KEY = 'migrations-renumbered';

/**
 * The key of the batch notice that lists the migrations a merge of the base lost and 10db could not
 * re-create. It stands until the branch's journal holds them: no gate passes meanwhile, and every
 * later step of the batch is briefed from it, because re-creating them falls to the lane.
 */
export const MIGRATIONS_UNCARRIED_NOTICE_KEY = 'migrations-uncarried';

export const InboxTarget = z.object({
  workstreamId: WorkstreamId,
  sessionId: SessionId.nullable(),
});
export type InboxTarget = z.infer<typeof InboxTarget>;

export const InboxItemDto = z
  .object({
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
    /** Every handle the card is routed to, in routing order. */
    assignees: z.array(z.string()).default([]),
    routedBy: z.enum(RoutedBy).default(RoutedBy.Rule),
    /** What triage suggested below the floor, for the builder to confirm. */
    routeSuggestion: z
      .object({ personIds: z.array(PersonId), confidence: z.number() })
      .nullable()
      .default(null),
    send: StakeholderSendDto.nullable().default(null),
    detail: z.record(z.string(), z.json()).nullable(),
    answer: RecordedAnswer.nullable(),
    targets: z.array(InboxTarget),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  // A card stored before routing named one assignee; its list is that one.
  .overwrite((card) =>
    card.assignees.length === 0 ? { ...card, assignees: [card.assignee] } : card,
  );
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

/**
 * What a check left behind: a gate's or agent's command and exit code, the builder's note, or 10db's
 * record that no revert of the run stands.
 */
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
  z.object({
    ...EvidenceBase,
    kind: z.literal(EvidenceKind.NoRevert),
    command: z.null(),
    exitCode: z.null(),
  }),
]);
export type EvidenceDto = z.infer<typeof EvidenceDto>;
