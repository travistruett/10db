import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultDataDir } from '../src/runtime-files/data-dir';
import {
  AccountKind,
  AccountPauseReason,
  BatchState,
  Delivery,
  Effort,
  InboxKind,
  PullRequestChecks,
  PullRequestState,
  QuestionCategory,
  StepRole,
  StepStatus,
  TaskStatus,
  ToolAccess,
  Urgency,
  WORKSTREAM_FAILED_TITLE_PREFIX,
  WorkstreamFailure,
  WorkstreamState,
  WorkstreamStep,
  type BatchId,
  type ProjectId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  createStore,
  findPersonByHandle,
  insertAccount,
  insertBatch,
  insertDraft,
  insertGoal,
  insertInboxItem,
  insertPerson,
  insertProject,
  insertTask,
  insertWorkstream,
  listAccounts,
  listProjects,
  markSending,
  markSent,
  openDatabase,
  patchAccount,
  patchBatch,
  patchWorkstream,
  recordPullRequestStatus,
  setAppSetting,
  setTaskStatus,
  transitionBatch,
  transitionWorkstream,
  type WriteContext,
} from '@10db/db';

/**
 * Seeds three demo projects with goals and tasks in every state Factory shows, for working on its design in
 * the dev app: runs that are running, paused, queued, held, failed, waiting on the builder or on a person,
 * in review and merged, spread over the last three days. Each project gets a small git repository in
 * `<database dir>/../factory-demo/<name>`. The rows are written straight into the database file of a daemon
 * that is idle; a database that already has the demo projects is left alone.
 *
 * Nothing seeded ever runs: the projects use their own account, "Factory demo (never runs)", which is
 * paused with no end, so the scheduler launches none of their queued work. Startup recovery re-queues the
 * runs seeded as running, so they show as queued once the daemon has started.
 *
 * Usage: seed-factory-demo.ts <database>
 */

const MINUTE_MS = 60_000;
const DEMO_ACCOUNT = 'Factory demo (never runs)';
const DEMO_IDENTITY = 'factory-demo@10db.invalid';
const PR_REPO = 'https://github.com/acme-demo';

const hours = (n: number): number => n * 60;
const days = (n: number): number => n * 24 * 60;

interface Question {
  readonly title: string;
  readonly body: string;
  readonly options: readonly string[];
  readonly recommendation: string | null;
  readonly category: QuestionCategory;
}

interface PullRequest {
  readonly number: number;
  readonly merged: boolean;
  readonly title: string;
}

/** How a task's one run went; every time is in minutes before the seed runs. */
type Run =
  | { readonly kind: 'none' }
  | { readonly kind: 'queued'; readonly at: number }
  | { readonly kind: 'held'; readonly at: number }
  | {
      readonly kind: 'running';
      readonly start: number;
      readonly step: number;
      readonly activity: number;
      readonly contextPct: number;
    }
  | {
      readonly kind: 'paused';
      readonly start: number;
      readonly step: number;
      readonly at: number;
      readonly resetsIn: number;
    }
  | {
      readonly kind: 'asks_builder';
      readonly start: number;
      readonly step: number;
      readonly at: number;
      readonly question: Question;
    }
  | {
      readonly kind: 'asks_person';
      readonly start: number;
      readonly step: number;
      readonly at: number;
      readonly question: Question;
    }
  | {
      readonly kind: 'failed';
      readonly start: number;
      readonly end: number;
      readonly step: number;
      readonly failure: WorkstreamFailure;
      readonly reason: string;
    }
  | {
      readonly kind: 'done';
      readonly start: number;
      readonly end: number;
      readonly pr: PullRequest | null;
    };

interface TaskSpec {
  readonly key: string;
  readonly title: string;
  readonly why: string;
  readonly areas: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly run: Run;
}

interface GoalSpec {
  readonly title: string;
  readonly objective: string;
  readonly createdAgo: number;
  readonly tasks: readonly TaskSpec[];
}

interface ProjectSpec {
  readonly name: string;
  readonly delivery: Delivery;
  readonly areas: readonly string[];
  readonly createdAgo: number;
  readonly goals: readonly GoalSpec[];
  /** Tasks in no goal. */
  readonly loose: readonly TaskSpec[];
}

const done = (start: number, end: number, pr: PullRequest | null = null): Run => ({
  kind: 'done',
  start,
  end,
  pr,
});

const PROJECTS: readonly ProjectSpec[] = [
  {
    name: 'acme-app',
    delivery: Delivery.PullRequest,
    areas: ['web', 'api', 'mobile', 'docs'],
    createdAgo: days(6),
    goals: [
      {
        title: 'Self-serve onboarding',
        objective:
          'A new team signs up, sets up its workspace and invites teammates without talking to sales.',
        createdAgo: days(3) + hours(2),
        tasks: [
          {
            key: 'verify-email',
            title: 'Add an email verification step to sign-up',
            why: 'Unverified sign-ups are a third of our spam accounts.',
            areas: ['web', 'api'],
            run: done(days(2) + hours(5), days(2) + hours(3), {
              number: 476,
              merged: true,
              title: 'feat(onboarding): verify email at sign-up',
            }),
          },
          {
            key: 'setup-wizard',
            title: 'Build the workspace setup wizard',
            why: 'Teams drop off when the first screen is an empty dashboard.',
            areas: ['web'],
            run: done(hours(9), hours(6), {
              number: 482,
              merged: false,
              title: 'feat(onboarding): workspace setup wizard',
            }),
          },
          {
            key: 'invite-teammates',
            title: 'Invite teammates from the setup wizard',
            why: 'A workspace with one member churns within a week.',
            areas: ['web', 'api'],
            run: {
              kind: 'failed',
              start: hours(7),
              end: 95,
              step: 2,
              failure: WorkstreamFailure.RejectedAtLimit,
              reason:
                'Review rejected the work three times: invites are sent before the workspace is saved, so a failed save leaves invitees with a dead link.',
            },
          },
          {
            key: 'funnel-events',
            title: 'Track onboarding funnel events',
            why: 'We cannot tell which wizard step loses people.',
            areas: ['web'],
            run: {
              kind: 'failed',
              start: hours(4),
              end: 70,
              step: 1,
              failure: WorkstreamFailure.NoResult,
              reason:
                'The implement step stopped: its session ended without calling complete_step after adding events to two of the five wizard steps.',
            },
          },
          {
            key: 'skip-wizard',
            title: 'Skip the wizard for invited users',
            why: 'Invited users join a workspace that is already set up.',
            areas: ['web'],
            dependsOn: ['invite-teammates'],
            run: { kind: 'none' },
          },
        ],
      },
      {
        title: 'Mobile push notifications',
        objective: 'People hear about mentions and replies on their phone within a minute.',
        createdAgo: days(2),
        tasks: [
          {
            key: 'register-devices',
            title: 'Register devices for push with APNs and FCM',
            why: 'Nothing can be pushed until we know where to send it.',
            areas: ['mobile', 'api'],
            run: done(days(1) + hours(20), days(1) + hours(17), {
              number: 471,
              merged: true,
              title: 'feat(mobile): register devices for push',
            }),
          },
          {
            key: 'notification-prefs',
            title: 'Notification preferences screen',
            why: 'People mute an app that pushes too much.',
            areas: ['mobile'],
            run: {
              kind: 'asks_builder',
              start: hours(3),
              step: 1,
              at: 42,
              question: {
                title: 'Should marketing pushes be on or off for existing users?',
                body: 'The preferences screen needs a default for the new "Product news" switch. Existing users never agreed to marketing pushes.',
                options: ['Off until they opt in', 'On, with a one-time prompt to turn it off'],
                recommendation: 'Off until they opt in',
                category: QuestionCategory.Product,
              },
            },
          },
          {
            key: 'mention-push',
            title: 'Push a notification when someone is mentioned',
            why: 'Mentions are the reason most people open the app.',
            areas: ['api', 'mobile'],
            run: done(hours(8), hours(5), {
              number: 488,
              merged: false,
              title: 'feat(mobile): push on mentions',
            }),
          },
        ],
      },
      {
        title: 'Dark mode',
        objective: 'Every screen and email reads well in dark mode.',
        createdAgo: days(1) + hours(4),
        tasks: [
          {
            key: 'color-tokens',
            title: 'Define dark color tokens',
            why: 'Hard-coded colors are why dark mode keeps breaking.',
            areas: ['web'],
            run: done(hours(11), hours(9), {
              number: 485,
              merged: true,
              title: 'feat(web): dark color tokens',
            }),
          },
          {
            key: 'chart-dark',
            title: 'Dark mode for dashboard charts',
            why: 'Charts are unreadable on a dark background today.',
            areas: ['web'],
            run: done(hours(6), hours(3), {
              number: 491,
              merged: false,
              title: 'feat(web): dark charts and emails',
            }),
          },
          {
            key: 'email-dark',
            title: 'Dark mode for transactional emails',
            why: 'Mail clients invert our logo into a black square.',
            areas: ['api'],
            run: done(hours(5), hours(3) - 10, {
              number: 491,
              merged: false,
              title: 'feat(web): dark charts and emails',
            }),
          },
        ],
      },
    ],
    loose: [
      {
        key: 'flaky-login-test',
        title: 'Fix the flaky login redirect test',
        why: 'It fails one CI run in five.',
        areas: ['web'],
        run: {
          kind: 'failed',
          start: hours(2),
          end: 25,
          step: 1,
          failure: WorkstreamFailure.GateFailed,
          reason:
            'The gate failed after 2 fix attempts: `pnpm test` exited 1, with 3 failures in web/auth/redirect.spec.ts (expected /dashboard, got /login).',
        },
      },
      {
        key: 'rn-bump',
        title: 'Upgrade React Native to 0.79',
        why: 'The App Store requires the new SDK from next month.',
        areas: ['mobile'],
        run: done(hours(6), hours(4), {
          number: 489,
          merged: true,
          title: 'chore(mobile): upgrade React Native to 0.79',
        }),
      },
    ],
  },
  {
    name: 'billing-service',
    delivery: Delivery.PullRequest,
    areas: ['api', 'billing', 'db', 'docs'],
    createdAgo: days(10),
    goals: [
      {
        title: 'Usage-based pricing',
        objective:
          'Customers pay for the API calls they make beyond their plan, on the same invoice.',
        createdAgo: days(3),
        tasks: [
          {
            key: 'meter-api-calls',
            title: 'Meter API calls per workspace',
            why: 'Usage pricing starts with counting usage.',
            areas: ['api', 'db'],
            run: done(days(2) + hours(10), days(2) + hours(6), {
              number: 203,
              merged: true,
              title: 'feat(billing): meter API calls per workspace',
            }),
          },
          {
            key: 'nightly-aggregation',
            title: 'Aggregate usage into invoice lines nightly',
            why: 'Invoices are built from daily totals, not raw events.',
            areas: ['billing', 'db'],
            run: done(days(1) + hours(8), days(1) + hours(4), {
              number: 207,
              merged: true,
              title: 'feat(billing): nightly usage aggregation',
            }),
          },
          {
            key: 'overage-tiers',
            title: 'Price overage tiers',
            why: 'Overage needs a price before it can be billed.',
            areas: ['billing'],
            run: {
              kind: 'asks_person',
              start: hours(6),
              step: 1,
              at: hours(3) + 20,
              question: {
                title: 'Which overage rate applies to customers on legacy annual plans?',
                body: 'About 140 workspaces are still on annual contracts signed before the price change.',
                options: ['The new per-call rate', 'Their contract rate until renewal'],
                recommendation: null,
                category: QuestionCategory.Business,
              },
            },
          },
          {
            key: 'usage-chart',
            title: 'Usage chart on the billing page',
            why: 'Customers should see overage coming before the invoice does.',
            areas: ['api'],
            run: done(hours(7), hours(4) - 20, {
              number: 212,
              merged: false,
              title: 'feat(billing): usage chart on the billing page',
            }),
          },
          {
            key: 'usage-alerts',
            title: 'Email usage alerts at 80% and 100% of plan',
            why: 'Nobody likes a surprise invoice.',
            areas: ['billing'],
            dependsOn: ['overage-tiers'],
            run: { kind: 'none' },
          },
        ],
      },
      {
        title: 'Stripe Tax migration',
        objective: 'Every invoice is taxed by Stripe Tax and the TaxJar contract can end.',
        createdAgo: days(2) + hours(3),
        tasks: [
          {
            key: 'tax-codes',
            title: 'Map our tax codes to Stripe Tax product codes',
            why: 'Stripe Tax needs a product code on every line.',
            areas: ['billing'],
            run: done(days(1) + hours(6), days(1) + hours(3), {
              number: 209,
              merged: true,
              title: 'feat(billing): map tax codes to Stripe Tax',
            }),
          },
          {
            key: 'invoice-stripe-tax',
            title: 'Create invoices with Stripe Tax',
            why: 'This is the switch itself.',
            areas: ['billing', 'api'],
            run: { kind: 'running', start: hours(2), step: 2, activity: 2, contextPct: 41 },
          },
          {
            key: 'billing-address',
            title: 'Collect the billing address at checkout',
            why: 'Stripe Tax cannot place a customer without an address.',
            areas: ['api'],
            run: { kind: 'paused', start: hours(1) + 30, step: 1, at: 35, resetsIn: 85 },
          },
          {
            key: 'tax-exempt',
            title: 'Flag tax-exempt customers',
            why: 'Nonprofits are being charged tax they do not owe.',
            areas: ['billing'],
            dependsOn: ['invoice-stripe-tax'],
            run: { kind: 'queued', at: 50 },
          },
        ],
      },
      {
        title: 'Dunning emails',
        objective: 'Failed card payments recover without anyone at Acme chasing them.',
        createdAgo: hours(5),
        tasks: [
          {
            key: 'retry-schedule',
            title: 'Retry failed card payments on a schedule',
            why: 'Half of failed payments succeed on a retry within a week.',
            areas: ['billing'],
            run: { kind: 'queued', at: 40 },
          },
          {
            key: 'dunning-copy',
            title: 'Write the dunning email sequence',
            why: 'The default Stripe emails read as spam.',
            areas: ['docs'],
            dependsOn: ['retry-schedule'],
            run: { kind: 'queued', at: 38 },
          },
          {
            key: 'suspend-after-notice',
            title: 'Suspend the workspace after the final notice',
            why: 'Unpaid workspaces keep running on our servers.',
            areas: ['api', 'billing'],
            dependsOn: ['retry-schedule'],
            run: { kind: 'none' },
          },
        ],
      },
    ],
    loose: [
      {
        key: 'webhook-retries',
        title: 'Accept Stripe webhook retries with an old signature',
        why: 'Retried webhooks are dropped, so some payments never post.',
        areas: ['api'],
        run: {
          kind: 'failed',
          start: hours(5),
          end: hours(4),
          step: 1,
          failure: WorkstreamFailure.Blocked,
          reason:
            'Blocked: the staging webhook signing secret is not in .env.example or the test fixtures, so the signature check cannot be exercised. Add STRIPE_WEBHOOK_SECRET to the test env, then retry.',
        },
      },
      {
        key: 'prorated-refunds',
        title: 'Fix rounding on prorated refunds',
        why: 'Refunds are a cent short on odd-length months.',
        areas: ['billing'],
        run: { kind: 'running', start: 50, step: 1, activity: 4, contextPct: 23 },
      },
      {
        key: 'idempotency-keys',
        title: 'Add idempotency keys to the refund API',
        why: 'A double-click on Refund refunds twice.',
        areas: ['api', 'db'],
        run: {
          kind: 'asks_builder',
          start: hours(2),
          step: 0,
          at: 18,
          question: {
            title: 'How long should refund idempotency keys be kept?',
            body: 'Keys are stored per workspace; the retention sets the table size and how late a retry is still caught.',
            options: [
              '24 hours, as Stripe does',
              '7 days, to cover delayed retries from the mobile app',
            ],
            recommendation: '24 hours, as Stripe does',
            category: QuestionCategory.Engineering,
          },
        },
      },
    ],
  },
  {
    name: 'marketing-site',
    delivery: Delivery.Local,
    areas: ['pages', 'blog', 'design'],
    createdAgo: days(20),
    goals: [
      {
        title: 'Spring launch landing page',
        objective: 'The launch page is live with sign-up working before the announcement.',
        createdAgo: days(4),
        tasks: [
          {
            key: 'hero-section',
            title: 'Build the launch hero section',
            why: 'It is the first thing the announcement links to.',
            areas: ['pages', 'design'],
            run: done(days(3) + hours(4), days(3) + hours(2)),
          },
          {
            key: 'customer-logos',
            title: 'Add the customer logo strip',
            why: 'Social proof above the fold.',
            areas: ['pages'],
            run: done(days(3) + hours(1), days(2) + hours(22)),
          },
          {
            key: 'launch-signup-form',
            title: 'Wire the launch sign-up form to the waitlist',
            why: 'Sign-ups from the launch must reach the waitlist.',
            areas: ['pages'],
            run: done(days(2) + hours(8), days(2) + hours(5)),
          },
        ],
      },
      {
        title: 'Pricing page refresh',
        objective: 'The pricing page explains usage pricing before it ships.',
        createdAgo: days(1) + hours(6),
        tasks: [
          {
            key: 'pricing-cards',
            title: 'Redesign the plan cards',
            why: 'Three of five visitors misread which plan includes SSO.',
            areas: ['pages', 'design'],
            run: done(days(1) + hours(2), hours(22)),
          },
          {
            key: 'annual-toggle',
            title: 'Add the monthly and annual toggle',
            why: 'Annual pricing is hidden in the FAQ today.',
            areas: ['pages'],
            run: done(hours(5), hours(3) + 10),
          },
          {
            key: 'comparison-table',
            title: 'Plan comparison table',
            why: 'Sales keeps sending the same spreadsheet.',
            areas: ['pages'],
            run: { kind: 'held', at: hours(2) },
          },
          {
            key: 'pricing-faq',
            title: 'Rewrite the pricing FAQ for usage pricing',
            why: 'The FAQ still says there is no overage.',
            areas: ['pages'],
            run: { kind: 'none' },
          },
        ],
      },
      {
        title: 'Blog migration to MDX',
        objective: 'Posts are MDX files in the repository and the old CMS is switched off.',
        createdAgo: hours(20),
        tasks: [
          {
            key: 'mdx-pipeline',
            title: 'Set up the MDX build pipeline',
            why: 'Everything else in the migration builds on it.',
            areas: ['blog'],
            run: { kind: 'none' },
          },
          {
            key: 'redirect-old-urls',
            title: 'Redirect old CMS post URLs',
            why: 'Old links from search results must keep working.',
            areas: ['blog'],
            dependsOn: ['mdx-pipeline'],
            run: { kind: 'none' },
          },
          {
            key: 'migrate-posts',
            title: 'Migrate the 120 existing posts',
            why: 'The CMS contract ends next month.',
            areas: ['blog'],
            dependsOn: ['mdx-pipeline'],
            run: { kind: 'none' },
          },
        ],
      },
    ],
    loose: [
      {
        key: 'og-image-fix',
        title: 'Fix the broken OG image on /customers',
        why: 'Shared links to the customers page show no preview.',
        areas: ['pages'],
        run: done(hours(3), hours(2) + 15),
      },
      {
        key: 'compress-hero',
        title: 'Cut the home page hero to under 2 MB',
        why: 'The home page takes six seconds to load on mobile.',
        areas: ['pages', 'design'],
        run: {
          kind: 'asks_builder',
          start: hours(1),
          step: 1,
          at: 12,
          question: {
            title: 'Replace the hero video on mobile, or lazy-load it?',
            body: 'The hero video is 18 MB. A poster image gets mobile under 2 MB; lazy-loading keeps the video but still downloads it after the first paint.',
            options: ['A poster image on mobile', 'Keep the video and lazy-load it'],
            recommendation: 'A poster image on mobile',
            category: QuestionCategory.Design,
          },
        },
      },
    ],
  },
];

const [databaseArg] = process.argv.slice(2);
if (!databaseArg) throw new Error('usage: seed-factory-demo.ts <database>');
const databasePath = resolve(databaseArg);
if (!existsSync(databasePath))
  throw new Error(
    `${databasePath} does not exist: start the daemon once to create it, then stop it`,
  );
const dataDir = dirname(databasePath);
// The installed app's database is the builder's real factory; the demo is only for dev data dirs.
if (resolve(dataDir) === resolve(defaultDataDir()))
  throw new Error(`${databasePath} is the installed app's database: seed a dev data dir instead`);
const db = openDatabase(databasePath);
const startedAt = Date.now();
// The store's clock: each write is stamped with the time the seed set for it.
let now = new Date(startedAt);
const store = createStore(db, () => now);
const at = (minutesAgo: number): string => {
  now = new Date(startedAt - minutesAgo * MINUTE_MS);
  return now.toISOString();
};
const write = <T>(fn: (ctx: WriteContext) => T): T => store.write(fn).value;

const existing = listProjects(store.db).filter((p) => PROJECTS.some((s) => s.name === p.name));
if (existing.length > 0) {
  console.log(
    `The demo projects are already here (${existing.map((p) => p.name).join(', ')}); nothing written.`,
  );
  process.exit(0);
}

/** Git with none of the caller's `GIT_*` variables, so a hook's or a worktree's git setup never leaks in. */
function git(cwd: string, args: readonly string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return execFileSync('git', [...args], { cwd, env, encoding: 'utf8' }).trim();
}

/** A one-commit repository for the project, with a folder per area; one made by an earlier seed is reused. */
function demoRepository(spec: ProjectSpec): { path: string; head: string } {
  const path = resolve(dataDir, '..', 'factory-demo', spec.name);
  mkdirSync(path, { recursive: true });
  if (!existsSync(join(path, '.git'))) {
    git(path, ['init', '-q', '-b', 'main']);
    git(path, ['config', 'maintenance.auto', 'false']);
    git(path, ['config', 'gc.auto', '0']);
    git(path, ['config', 'receive.autogc', 'false']);
    writeFileSync(
      join(path, 'README.md'),
      `# ${spec.name}\n\nA demo project seeded for the 10db Factory view.\n`,
    );
    for (const area of spec.areas) {
      mkdirSync(join(path, area), { recursive: true });
      writeFileSync(join(path, area, 'README.md'), `# ${area}\n`);
    }
    git(path, ['add', '.']);
    git(path, [
      '-c',
      'user.name=10db',
      '-c',
      'user.email=demo@10db.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--no-verify',
      '-m',
      'chore: start the demo',
    ]);
  }
  return { path: realpathSync(path), head: git(path, ['rev-parse', 'HEAD']) };
}

/** The demo projects' account: ready to run, and paused with no end so nothing of theirs ever launches. */
function demoAccount() {
  const found = listAccounts(store.db).find((a) => a.label === DEMO_ACCOUNT);
  if (found) return found;
  at(days(21));
  const account = write((ctx) =>
    insertAccount(
      ctx,
      { kind: AccountKind.ClaudeSubscription, label: DEMO_ACCOUNT, payer: 'Factory demo' },
      { configDirFor: (id) => join(dataDir, 'accounts', id, 'claude') },
    ),
  );
  if (account.configDir !== null) mkdirSync(account.configDir, { recursive: true, mode: 0o700 });
  return write((ctx) => {
    // The key and shape `accounts/pauses.ts` restores at start: a refusal pause holds until the account is saved.
    setAppSetting(ctx, `account_pause.${account.id}`, {
      reason: AccountPauseReason.Refused,
      until: null,
      since: ctx.now,
    });
    return patchAccount(ctx, account.id, { expectedIdentity: DEMO_IDENTITY });
  });
}

/** Mark Ellis, who answers billing questions in Slack. */
function mark() {
  return (
    findPersonByHandle(store.db, 'mark-ellis') ??
    write((ctx) =>
      insertPerson(ctx, {
        handle: 'mark-ellis',
        name: 'Mark Ellis',
        slack: [{ teamId: 'T0DEMO', userId: 'U0MARK', sendMode: 'review', dailyLimit: 10 }],
      }),
    )
  );
}

const ROLES = [StepRole.Plan, StepRole.Implement, StepRole.Review, StepRole.Qa] as const;
const PERSONAS: Readonly<Record<(typeof ROLES)[number], string>> = {
  plan: 'Planner',
  implement: 'Implementer',
  review: 'Reviewer',
  qa: 'QA',
};

/** A four-step plan with the steps before `index` done and the one at `index` in `status`. */
function steps(index: number, status: StepStatus, startedAt: string): WorkstreamStep[] {
  return ROLES.map((role, i) =>
    WorkstreamStep.parse({
      role,
      personaId: null,
      personaName: PERSONAS[role],
      tools: role === StepRole.Implement ? ToolAccess.Edit : ToolAccess.ReadOnly,
      profileId: null,
      model:
        role === StepRole.Implement || role === StepRole.Qa
          ? 'claude-sonnet-4-5'
          : 'claude-opus-4-5',
      effort: role === StepRole.Implement ? Effort.Medium : Effort.High,
      need: 50,
      reason: 'the rigor plan',
      overBudget: false,
      pinned: false,
      status: i < index ? StepStatus.Done : i === index ? status : StepStatus.Pending,
      attempts: i === index && status === StepStatus.Failed ? 2 : 0,
      startedAt: i <= index ? startedAt : null,
      sessionFloor: i,
      result: null,
    }),
  );
}

const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

/** Inserts the run queued, then takes it through Starting to Running at `start`. */
function startRun(
  taskId: TaskId,
  title: string,
  start: number,
  step: number,
  head: string,
  batchId: BatchId | null,
) {
  const startedIso = at(start);
  const ws = write((ctx) =>
    insertWorkstream(ctx, taskId, {
      batchId,
      first: { model: 'claude-sonnet-4-5', effort: Effort.Medium },
    }),
  );
  write((ctx) => {
    transitionWorkstream(ctx, ws.id, {
      to: WorkstreamState.Starting,
      fence: null,
      patch: { baseHead: head, branch: `10db/${slug(title)}` },
      reason: 'lane granted',
    });
    transitionWorkstream(ctx, ws.id, {
      to: WorkstreamState.Running,
      fence: null,
      patch: {
        attempt: 1,
        steps: steps(step, StepStatus.Running, startedIso),
        stepIndex: step,
        lastActivityAt: startedIso,
      },
      reason: 'session started',
    });
  });
  return ws.id;
}

function questionCard(projectId: ProjectId, workstreamId: WorkstreamId, question: Question) {
  return write((ctx) =>
    insertInboxItem(ctx, {
      projectId,
      kind: InboxKind.Question,
      title: question.title,
      body: question.body,
      options: question.options.map((label) => ({ label, description: '' })),
      recommendation: question.recommendation,
      category: question.category,
      urgency: Urgency.Normal,
      detail: null,
      foldKey: null,
      targets: [{ workstreamId, sessionId: null }],
    }),
  );
}

interface Seeded {
  readonly projectId: ProjectId;
  readonly head: string;
}

/** Writes the task's run as its spec says. A finished run in a pull-request project ships in `batchId`. */
function seedRun(seeded: Seeded, taskId: TaskId, spec: TaskSpec, batchId: BatchId | null): void {
  const { run } = spec;
  switch (run.kind) {
    case 'none':
      return;
    case 'queued':
    case 'held': {
      at(run.at);
      const ws = write((ctx) =>
        insertWorkstream(ctx, taskId, {
          first: { model: 'claude-sonnet-4-5', effort: Effort.Medium },
        }),
      );
      if (run.kind === 'held')
        write((ctx) =>
          transitionWorkstream(ctx, ws.id, {
            to: WorkstreamState.Held,
            fence: null,
            reason: 'set aside',
          }),
        );
      return;
    }
    case 'running': {
      const id = startRun(taskId, spec.title, run.start, run.step, seeded.head, null);
      const activity = at(run.activity);
      write((ctx) => {
        patchWorkstream(ctx, id, null, { lastActivityAt: activity, contextPct: run.contextPct });
      });
      return;
    }
    case 'paused': {
      const id = startRun(taskId, spec.title, run.start, run.step, seeded.head, null);
      at(run.at);
      const until = new Date(startedAt + run.resetsIn * MINUTE_MS).toISOString();
      write((ctx) =>
        transitionWorkstream(ctx, id, {
          to: WorkstreamState.PausedLimit,
          fence: null,
          patch: { pausedUntil: until, lastActivityAt: ctx.now },
          reason: 'usage limit',
        }),
      );
      return;
    }
    case 'asks_builder':
    case 'asks_person': {
      const id = startRun(taskId, spec.title, run.start, run.step, seeded.head, null);
      const askedAt = at(run.at);
      const card = questionCard(seeded.projectId, id, run.question);
      write((ctx) =>
        transitionWorkstream(ctx, id, {
          to: WorkstreamState.WaitingHuman,
          fence: null,
          patch: {
            nextAction: { kind: 'answer', inboxId: card.id, providerSessionId: null },
            lastActivityAt: askedAt,
          },
          reason: 'asked a question',
        }),
      );
      if (run.kind === 'asks_builder') return;
      const person = mark();
      const send = write((ctx) =>
        insertDraft(ctx, {
          inboxItemId: card.id,
          teamId: 'T0DEMO',
          recipients: [person.id],
          text: `Hi Mark, ${run.question.title} ${run.question.body}`,
          hits: [],
        }),
      );
      write((ctx) => {
        markSending(ctx, send.id, { textSha256: 'seeded', threadTs: null, startedAt: askedAt });
        markSent(ctx, send.id, {
          channelId: 'D0DEMO',
          threadTs: '1700000000.000100',
          messageTs: '1700000000.000100',
          permalink: null,
          at: askedAt,
        });
      });
      return;
    }
    case 'failed': {
      const id = startRun(taskId, spec.title, run.start, run.step, seeded.head, null);
      const endedAt = at(run.end);
      write((ctx) => {
        // A gate failure is found while verifying; every other failure ends the running session.
        if (run.failure === WorkstreamFailure.GateFailed)
          transitionWorkstream(ctx, id, {
            to: WorkstreamState.Verifying,
            fence: null,
            patch: { nextAction: { kind: 'verify' } },
          });
        transitionWorkstream(ctx, id, {
          to: WorkstreamState.Failed,
          fence: null,
          patch: {
            failureReason: run.reason,
            failureKind: run.failure,
            steps: steps(run.step, StepStatus.Failed, endedAt),
            lastActivityAt: endedAt,
          },
          reason: 'failed',
        });
        insertInboxItem(ctx, {
          projectId: seeded.projectId,
          kind: InboxKind.Flag,
          title: `${WORKSTREAM_FAILED_TITLE_PREFIX}${spec.title}`,
          body: run.reason,
          options: [],
          recommendation: null,
          category: QuestionCategory.Engineering,
          urgency: Urgency.High,
          detail: null,
          foldKey: null,
          targets: [{ workstreamId: id, sessionId: null }],
        });
      });
      return;
    }
    case 'done': {
      const id = startRun(taskId, spec.title, run.start, ROLES.length - 1, seeded.head, batchId);
      const endedAt = at(run.end);
      write((ctx) => {
        transitionWorkstream(ctx, id, {
          to: WorkstreamState.Verifying,
          fence: null,
          patch: {
            steps: steps(ROLES.length, StepStatus.Done, endedAt),
            stepIndex: ROLES.length - 1,
          },
        });
        transitionWorkstream(ctx, id, {
          to: WorkstreamState.Done,
          fence: null,
          patch: { lastActivityAt: endedAt },
          reason: 'gate passed',
        });
        setTaskStatus(ctx, taskId, TaskStatus.Done);
      });
      return;
    }
  }
}

/**
 * The finished tasks of one pull request: a batch cut before the first starts, every run in it done, then
 * shipped with its pull request open or merged. A project has one unfinished batch at a time, so each
 * batch ships before the next is cut.
 */
function seedPullRequest(
  seeded: Seeded,
  projectName: string,
  pr: PullRequest,
  members: readonly { taskId: TaskId; spec: TaskSpec; start: number; end: number }[],
): void {
  const firstStart = Math.max(...members.map((m) => m.start));
  const lastEnd = Math.min(...members.map((m) => m.end));
  at(firstStart + 2);
  const batch = write((ctx) =>
    insertBatch(ctx, { projectId: seeded.projectId, title: pr.title, baseBranch: 'main' }),
  );
  write((ctx) =>
    transitionBatch(ctx, batch.id, {
      to: BatchState.Open,
      patch: { branch: `10db/batch-${String(pr.number)}`, baseSha: seeded.head },
    }),
  );
  for (const m of members) seedRun(seeded, m.taskId, m.spec, batch.id);
  at(lastEnd - 3);
  write((ctx) => transitionBatch(ctx, batch.id, { to: BatchState.Shipping }));
  const shippedAt = at(lastEnd - 5);
  write((ctx) => {
    patchBatch(ctx, batch.id, { prUrl: `${PR_REPO}/${projectName}/pull/${String(pr.number)}` });
    transitionBatch(ctx, batch.id, { to: BatchState.Shipped });
  });
  // A merged pull request was merged within the hour; an open one was last read at its shipping.
  const readAt = pr.merged ? at(Math.max(lastEnd - 50, 1)) : shippedAt;
  write((ctx) =>
    recordPullRequestStatus(ctx, batch.id, {
      state: pr.merged ? PullRequestState.Merged : PullRequestState.Open,
      checks: PullRequestChecks.Passing,
      failingChecks: [],
      checkedAt: readAt,
      unknownReason: null,
    }),
  );
}

function seedProject(spec: ProjectSpec, accountId: ReturnType<typeof demoAccount>['id']): void {
  const repo = demoRepository(spec);
  at(spec.createdAgo);
  const project = write((ctx) =>
    insertProject(ctx, {
      name: spec.name,
      repoPath: repo.path,
      gateCommand: 'pnpm test',
      areas: spec.areas.map((name) => ({ name, globs: [`${name}/**`] })),
      delivery: spec.delivery,
      accountId,
    }),
  );
  const seeded: Seeded = { projectId: project.id, head: repo.head };
  const tasks: { taskId: TaskId; spec: TaskSpec }[] = [];

  for (const goal of spec.goals) {
    at(goal.createdAgo);
    const { taskIds } = write((ctx) =>
      insertGoal(ctx, project.id, {
        brief: {
          title: goal.title,
          objective: goal.objective,
          tasks: goal.tasks.map((t) => ({
            key: t.key,
            title: t.title,
            why: t.why,
            criteria: [`${t.title} works as described`],
            areas: [...t.areas],
            depends_on: [...(t.dependsOn ?? [])],
          })),
        },
      }),
    );
    for (const t of goal.tasks) {
      const taskId = taskIds.get(t.key);
      if (taskId === undefined) throw new Error(`insertGoal made no task for ${t.key}`);
      tasks.push({ taskId, spec: t });
    }
  }

  const looseIds = new Map<string, TaskId>();
  for (const t of spec.loose) {
    const start =
      t.run.kind === 'none' ? spec.createdAgo : 'start' in t.run ? t.run.start : t.run.at;
    at(start + 30);
    const task = write((ctx) =>
      insertTask(ctx, project.id, {
        title: t.title,
        why: t.why,
        acceptanceCriteria: [`${t.title} works as described`],
        areas: [...t.areas],
        dependsOn: (t.dependsOn ?? []).flatMap((key) => looseIds.get(key) ?? []),
      }),
    );
    looseIds.set(t.key, task.id);
    tasks.push({ taskId: task.id, spec: t });
  }

  // Finished runs ship by pull request in a pull-request project, grouped by its number.
  const prs = new Map<
    number,
    { pr: PullRequest; members: { taskId: TaskId; spec: TaskSpec; start: number; end: number }[] }
  >();
  for (const { taskId, spec: t } of tasks) {
    const run = t.run;
    if (run.kind === 'done' && run.pr !== null && spec.delivery === Delivery.PullRequest) {
      const group = prs.get(run.pr.number) ?? { pr: run.pr, members: [] };
      group.members.push({ taskId, spec: t, start: run.start, end: run.end });
      prs.set(run.pr.number, group);
    } else seedRun(seeded, taskId, t, null);
  }
  for (const { pr, members } of prs.values()) seedPullRequest(seeded, spec.name, pr, members);
  console.log(
    `${spec.name}: ${String(tasks.length)} tasks in ${String(spec.goals.length)} goals, repository ${repo.path}`,
  );
}

const account = demoAccount();
for (const spec of PROJECTS) seedProject(spec, account.id);
console.log(`Seeded the Factory demo on the paused account "${DEMO_ACCOUNT}".`);
