import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { FailingCheckDto, PullRequestChecks } from '@10db/contracts';
import { z } from 'zod';
import {
  INSTALL_PREFIXES_TEXT,
  withDaemonGitConfig,
  withoutGitRepoEnv,
  XCODE_SELECTORS,
} from '../git';

/** One `gh` call: in which environment, for how long, and how to stop it. */
export interface GhCall {
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export const GhFailure = {
  NotInstalled: 'not_installed',
  SignedOut: 'signed_out',
  Timeout: 'timeout',
  Aborted: 'aborted',
  /** gh ran but never reached GitHub: no DNS, no route, or a connection refused or timed out. */
  Unreachable: 'unreachable',
  Failed: 'failed',
} as const;
export type GhFailure = (typeof GhFailure)[keyof typeof GhFailure];

/** A `gh` call that did not give an answer; `kind` picks the card text. */
export class GhError extends Error {
  override readonly name = 'GhError';
  readonly kind: GhFailure;
  constructor(kind: GhFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}

export const PrState = { Open: 'OPEN', Closed: 'CLOSED', Merged: 'MERGED' } as const;
export type PrState = (typeof PrState)[keyof typeof PrState];

export interface PullRequest {
  readonly url: string;
  readonly state: PrState;
}

/**
 * A pull request's state and checks as GitHub reports them. The checks are `unknown` only when the
 * rollup lists an entry 10db can't read and no other check failed or is still running.
 */
export interface PullRequestStatus {
  readonly url: string;
  readonly state: PrState;
  /** The commit the pull request's branch was at when GitHub last saw it; null when gh gives none. */
  readonly headSha: string | null;
  readonly checks: PullRequestChecks;
  readonly failingChecks: FailingCheckDto[];
  /**
   * Why GitHub will not merge the pull request as it is, from its `mergeStateStatus`: `conflicts` for
   * DIRTY, `behind` for BEHIND, null for anything else (clean, blocked, unknown, a value added later).
   */
  readonly mergeBlocked: MergeBlocked | null;
}

export const MergeBlocked = { Conflicts: 'conflicts', Behind: 'behind' } as const;
export type MergeBlocked = (typeof MergeBlocked)[keyof typeof MergeBlocked];

/** One required check of a pull request, with the Actions ids its link carries (null when it has none). */
export interface CiJob {
  readonly name: string;
  /** An https link to the check's page, or null. */
  readonly link: string | null;
  /** The Actions job id, from a link `…/actions/runs/R/job/J`; null for a check that is no Actions job. */
  readonly jobId: string | null;
  /** The Actions run id, from the same link; null for a check that is no Actions run. */
  readonly runId: string | null;
  readonly description: string | null;
}

/**
 * The required checks of a pull request's base, as `gh pr checks --required` reports them: `failing`
 * if any failed, else `pending` if any is running, queued or cancelled (a run a newer push replaced),
 * else `passing`; `none` when GitHub reports no required checks. `pending` lists the pending and
 * cancelled ones, `failing` the failed ones.
 */
export interface RequiredChecks {
  readonly state: 'passing' | 'pending' | 'failing' | 'none';
  readonly failing: CiJob[];
  readonly pending: CiJob[];
}

/** A failed job's log: `not_yet` while its run is still in progress, which is no error. */
export type JobLog =
  { readonly kind: 'ready'; readonly log: string } | { readonly kind: 'not_yet' };

/** The host integration (batch delivery spec §7): everything 10db asks GitHub, through the gh CLI. */
export interface Gh {
  authStatus(call: GhCall): Promise<void>;
  /** The signed-in login, or null when gh is signed out. Throws on anything else (no network, a timeout). */
  authLogin(call: GhCall): Promise<string | null>;
  prView(
    input: { readonly repo: string; readonly ref: string },
    call: GhCall,
  ): Promise<PullRequest | null>;
  /**
   * The pull request's state and checks, or null when GitHub has none there for this account: none
   * at that number, or its repository is gone or closed to the account.
   */
  prStatus(
    input: { readonly repo: string; readonly ref: string },
    call: GhCall,
  ): Promise<PullRequestStatus | null>;
  /**
   * The pull request's required checks. Throws a GhError, never answers `none`, for any failure of
   * the call itself: no network, signed out, a server error.
   */
  prRequiredChecks(
    input: { readonly repo: string; readonly url: string },
    call: GhCall,
  ): Promise<RequiredChecks>;
  /**
   * The log of the failed steps of an Actions job (`jobId` is a number as text), or `not_yet` while its
   * run is in progress. Throws a GhError for anything else, such as a log GitHub no longer keeps.
   */
  jobLog(input: { readonly repo: string; readonly jobId: string }, call: GhCall): Promise<JobLog>;
  /** Reruns the failed jobs of an Actions run. Throws a GhError with GitHub's reason when it refuses. */
  rerunFailed(
    input: { readonly repo: string; readonly runId: string },
    call: GhCall,
  ): Promise<void>;
  prCreate(
    input: {
      readonly repo: string;
      readonly base: string;
      readonly head: string;
      readonly title: string;
      readonly bodyFile: string;
    },
    call: GhCall,
  ): Promise<string>;
  /** Whether the repository lets a pull request merge by itself once its required checks pass. */
  repoAllowsAutoMerge(repo: string, call: GhCall): Promise<boolean>;
  /**
   * Turns on squash auto-merge for the pull request: GitHub merges it once its required checks
   * pass. Throws a GhError when GitHub refuses, with its reason, such as a pull request that has
   * nothing left to wait for.
   */
  prAutoMerge(input: { readonly repo: string; readonly url: string }, call: GhCall): Promise<void>;
  /**
   * Squash-merges the pull request now, for one with nothing to wait for. Throws a GhError when
   * GitHub refuses, with its reason, such as a conflict or a branch rule.
   */
  prMerge(input: { readonly repo: string; readonly url: string }, call: GhCall): Promise<void>;
}

export interface GhOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs gh. Throws GhError for not installed, timeout and abort; returns any exit code otherwise. */
export type GhExec = (args: readonly string[], call: GhCall) => Promise<GhOutput>;

/** gh's documented exit code for "authentication required". */
const AUTH_REQUIRED_EXIT = 4;
const NO_PR = /no pull requests found/i;
/**
 * GitHub's own answer that a pull request named by URL or number isn't there for this account: gh
 * looks it up by number and prints the GraphQL error as it came, `GraphQL: Could not resolve to a
 * PullRequest with the number of 8. (repository.pullRequest)`, or `... to a Repository with the name
 * 'owner/name'. (repository)` when the repository is gone or closed to the account.
 */
const PR_NOT_FOUND = /could not resolve to a (pullrequest|repository)\b/i;
const SIGNED_OUT = /gh auth login|not logged in/i;
/**
 * gh's words when it never reached GitHub: its own line for a DNS failure, or the network error Go
 * gave it (`dial tcp ...: i/o timeout`, `connection refused`, a TLS handshake that timed out).
 */
const UNREACHABLE =
  /error connecting to|check your internet connection|dial (tcp|udp)|i\/o timeout|connection (refused|reset)|network is unreachable|no route to host|no such host|tls handshake timeout|client\.timeout exceeded/i;
const MAX_OUTPUT = 4 * 1024 * 1024;
/** Prompts are off whatever the environment says: nobody can answer one. */
const NO_PROMPTS = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const;

/** The binaries a `gh` call runs, as the daemon resolved them at startup. */
export interface GhTools {
  /** The gh to run, from a fixed install prefix; null when none is installed there. */
  readonly gh: string | null;
  /** The git the daemon runs, whose directory leads gh's PATH. */
  readonly git: string;
}

const notInstalled = (): GhError =>
  new GhError(
    GhFailure.NotInstalled,
    `10db found no gh in ${INSTALL_PREFIXES_TEXT}. Install the GitHub CLI (brew install gh) and sign in with gh auth login.`,
  );

/**
 * Runs `tools.gh` in an empty directory of its own, so it finds no repository and runs no git in a
 * checkout; every call names its repository with `-R`. Any git it does run is the daemon's own, first
 * on its PATH, with the daemon's own config, no hook's `GIT_DIR` and nothing that steers Xcode's shim.
 */
export function createSystemGhExec(tools: GhTools): GhExec {
  return (args, call) =>
    new Promise((resolve, reject) => {
      const { gh } = tools;
      if (gh === null) {
        reject(notInstalled());
        return;
      }
      const cwd = mkdtempSync(join(tmpdir(), '10db-gh-'));
      const done = (): void => {
        rmSync(cwd, { recursive: true, force: true });
      };
      const given = Object.fromEntries(
        Object.entries(withoutGitRepoEnv(call.env)).filter(
          ([name]) => !XCODE_SELECTORS.includes(name),
        ),
      );
      const loginPath = given['PATH'];
      const env = withDaemonGitConfig({
        ...given,
        ...NO_PROMPTS,
        PATH: loginPath ? `${dirname(tools.git)}${delimiter}${loginPath}` : dirname(tools.git),
      });
      execFile(
        gh,
        [...args],
        {
          cwd,
          env,
          timeout: call.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_OUTPUT,
          encoding: 'utf8',
          ...(call.signal ? { signal: call.signal } : {}),
        },
        (error, stdout, stderr) => {
          done();
          if (!error) {
            resolve({ exitCode: 0, stdout, stderr });
            return;
          }
          if (call.signal?.aborted) {
            reject(new GhError(GhFailure.Aborted, 'gh was stopped'));
            return;
          }
          // Removed since startup, as an uninstall does.
          if (error.code === 'ENOENT') {
            reject(notInstalled());
            return;
          }
          // Node kills a child whose output passes maxBuffer, so this comes before `killed`.
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(
              new GhError(
                GhFailure.Failed,
                `gh ${args.slice(0, 2).join(' ')} printed more than ${String(MAX_OUTPUT / 1024 / 1024)} MB, so 10db stopped it`,
              ),
            );
            return;
          }
          if (error.killed) {
            reject(
              new GhError(
                GhFailure.Timeout,
                `gh ${args.slice(0, 2).join(' ')} gave no answer within ${String(Math.round(call.timeoutMs / 1000))} s`,
              ),
            );
            return;
          }
          resolve({ exitCode: typeof error.code === 'number' ? error.code : 1, stdout, stderr });
        },
      );
    });
}

const PrView = z.object({ url: z.url(), state: z.enum(PrState) });
/** The repository's REST answer; `gh repo view --json` has no auto-merge field in every gh. */
const RepoSettings = z.object({ allow_auto_merge: z.boolean() });

/**
 * A pull request URL in `repo` (`owner/name`), on any GitHub host: https and
 * `/<owner>/<name>/pull/<number>`. GitHub compares owner and name without case.
 */
function prUrlIn(repo: string) {
  return z.url({ protocol: /^https$/ }).refine((url) => {
    // zod runs a refinement even when the URL check failed.
    if (!URL.canParse(url)) return false;
    const path = /^\/([^/]+\/[^/]+)\/pull\/\d+$/.exec(new URL(url).pathname);
    return path?.[1]?.toLowerCase() === repo.toLowerCase();
  });
}

/**
 * One entry of gh's `statusCheckRollup`: a check run (GitHub Actions and apps) or a commit status.
 * Values are plain strings, so a state GitHub adds later reads as "not failing" rather than breaking the read.
 */
const CheckRunItem = z.object({
  __typename: z.literal('CheckRun'),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullish(),
  detailsUrl: z.string().nullish(),
});
const StatusContextItem = z.object({
  __typename: z.literal('StatusContext'),
  context: z.string(),
  state: z.string(),
  targetUrl: z.string().nullish(),
});
const CheckRollupItem = z.discriminatedUnion('__typename', [CheckRunItem, StatusContextItem]);
export type CheckRollupItem = z.infer<typeof CheckRollupItem>;

/**
 * A rollup entry 10db can't read: a kind GitHub adds later, or a known kind missing a field. It
 * stands for a check whose outcome 10db doesn't know.
 */
export const UNREADABLE_CHECK = { __typename: 'Unreadable' } as const;
export type CheckRollupEntry = CheckRollupItem | typeof UNREADABLE_CHECK;

/** Reads one rollup entry on its own, so an entry 10db can't read leaves the rest of the read standing. */
function rollupEntry(raw: unknown): CheckRollupEntry {
  const item = CheckRollupItem.safeParse(raw);
  return item.success ? item.data : UNREADABLE_CHECK;
}

/** An Actions id in a call: digits only, so it can never be read as a gh flag. */
const ACTIONS_ID = /^\d{1,20}$/;
const ACTIONS_PATH = /^\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(?:\/jobs?\/(\d+))?\/?$/;

/**
 * The Actions run and job a check link names: `https://github.com/<owner>/<repo>/actions/runs/<R>/job/<J>`
 * gives both, a link to the run gives only the run, and anything else (a commit status from another CI,
 * a link that is not https, no link) gives neither.
 */
export function jobIdsOfLink(link: string | null | undefined): {
  runId: string | null;
  jobId: string | null;
} {
  const none = { runId: null, jobId: null };
  if (link === null || link === undefined || httpsOrNull(link) === null) return none;
  const match = ACTIONS_PATH.exec(new URL(link).pathname);
  if (!match) return none;
  return { runId: match[1] ?? null, jobId: match[2] ?? null };
}

const MERGE_BLOCKED: Readonly<Record<string, MergeBlocked>> = {
  DIRTY: MergeBlocked.Conflicts,
  BEHIND: MergeBlocked.Behind,
};

const PrStatusView = z.object({
  url: z.url(),
  state: z.enum(PrState),
  headRefOid: z
    .string()
    .nullish()
    .transform((oid) => (oid === undefined || oid === null || oid === '' ? null : oid)),
  statusCheckRollup: z.array(z.unknown().transform(rollupEntry)).nullish(),
  mergeStateStatus: z
    .string()
    .nullish()
    .transform((state) => MERGE_BLOCKED[state ?? ''] ?? null),
});

/** One entry of `gh pr checks --json name,state,bucket,link,workflow,description`. */
const RequiredCheckItem = z.object({
  name: z.string(),
  bucket: z.string(),
  link: z.string().nullish(),
  description: z.string().nullish(),
});
const RequiredChecksView = z.array(RequiredCheckItem);

const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const FAILING_STATES = new Set(['FAILURE', 'ERROR']);
const PENDING_STATES = new Set(['PENDING', 'EXPECTED']);

/** Only an https link is kept: it ends up in a card and a button. */
function httpsOrNull(url: string | null | undefined): string | null {
  return url?.startsWith('https://') && URL.canParse(url) ? url : null;
}

/**
 * What a rollup says: failing if any check failed (failing wins), pending if any is still going or
 * expected, unknown if an entry 10db can't read is left, none for an empty rollup, else passing.
 * Cancelled, skipped, neutral and stale runs don't fail.
 */
export function summariseChecks(rollup: readonly CheckRollupEntry[]): {
  checks: PullRequestChecks;
  failingChecks: FailingCheckDto[];
} {
  const failingChecks: FailingCheckDto[] = [];
  let pending = false;
  let unreadable = false;
  for (const item of rollup) {
    switch (item.__typename) {
      case 'CheckRun':
        if (item.status !== 'COMPLETED') pending = true;
        else if (FAILING_CONCLUSIONS.has(item.conclusion ?? ''))
          failingChecks.push({ name: item.name, url: httpsOrNull(item.detailsUrl) });
        break;
      case 'StatusContext':
        if (FAILING_STATES.has(item.state))
          failingChecks.push({ name: item.context, url: httpsOrNull(item.targetUrl) });
        else if (PENDING_STATES.has(item.state)) pending = true;
        break;
      case 'Unreadable':
        unreadable = true;
        break;
    }
  }
  if (failingChecks.length > 0) return { checks: 'failing', failingChecks };
  if (pending) return { checks: 'pending', failingChecks };
  if (unreadable) return { checks: 'unknown', failingChecks };
  return { checks: rollup.length === 0 ? 'none' : 'passing', failingChecks };
}

function failure(args: readonly string[], out: GhOutput): GhError {
  if (out.exitCode === AUTH_REQUIRED_EXIT || SIGNED_OUT.test(out.stderr))
    return new GhError(
      GhFailure.SignedOut,
      'gh is not signed in. Run gh auth login in a terminal.',
    );
  return new GhError(
    UNREACHABLE.test(out.stderr) ? GhFailure.Unreachable : GhFailure.Failed,
    `gh ${args.slice(0, 2).join(' ')} failed (exit ${String(out.exitCode)}): ${out.stderr.trim().slice(0, 500)}`,
  );
}

/** gh's exit codes for `gh pr checks`: 0 all passed, 1 one failed, 8 one pending. */
const CHECKS_EXITS = new Set([0, 1, 8]);
/**
 * gh's two messages of none, matched against the whole of stderr. "no checks reported on the '<branch>'
 * branch" comes when the head commit has no checks at all, which gh says before it filters to
 * `--required`: a base with no CI, or a pull request pushed before GitHub lists its runs. "no required
 * checks reported …" comes when checks exist and none is required. Both are in gh 2.83.2's binary.
 */
const NO_CHECKS = /^no (?:required )?checks reported on the '.*' branch$/i;
/** gh's `job <id> is still in progress; logs will be available when it is complete` (or `run <id> …`). */
const RUN_IN_PROGRESS =
  /^(?:job|run) \d+ is still in progress; logs will be available when it is complete$/i;

/**
 * Reads what `gh pr checks --required --json …` printed, from its exit code and both streams together.
 * With a list on stdout (and exit 0, 1 or 8, gh's codes for passed, failed and pending) the list decides.
 * gh's message of none ("no checks reported …" or "no required checks reported …") as the whole of
 * stderr, with exit 1 and nothing on stdout, is `none`; nothing else is. Any other failure, a network or
 * auth error with the same exit code included, throws a GhError, so it is never read as `none`.
 */
export function parseRequiredChecks(args: readonly string[], out: GhOutput): RequiredChecks {
  const none: RequiredChecks = { state: 'none', failing: [], pending: [] };
  const empty = out.stdout.trim() === '';
  if (CHECKS_EXITS.has(out.exitCode) && !empty) {
    const items = parseOutput(RequiredChecksView, args, out.stdout);
    const failing: CiJob[] = [];
    const pending: CiJob[] = [];
    for (const item of items) {
      const link = httpsOrNull(item.link);
      const job: CiJob = {
        name: item.name,
        link,
        ...jobIdsOfLink(link),
        // gh prints "" for a check with no description.
        description:
          item.description === undefined || item.description === null || item.description === ''
            ? null
            : item.description,
      };
      switch (item.bucket) {
        case 'pass':
        case 'skipping':
          break;
        case 'fail':
          failing.push(job);
          break;
        case 'pending':
        case 'cancel':
          pending.push(job);
          break;
        default:
          throw new GhError(
            GhFailure.Failed,
            `gh ${args.slice(0, 2).join(' ')} printed a check bucket 10db doesn't know: ${item.bucket.slice(0, 40)}`,
          );
      }
    }
    if (failing.length > 0) return { state: 'failing', failing, pending };
    if (pending.length > 0) return { state: 'pending', failing, pending };
    return items.length === 0 ? none : { state: 'passing', failing, pending };
  }
  if (out.exitCode === 1 && empty && NO_CHECKS.test(out.stderr.trim())) return none;
  throw failure(args, out);
}

/**
 * Reads what `gh run view --job <id> --log-failed` printed: the log on exit 0 (empty when no step
 * failed), `not_yet` when gh says the run is still in progress, else a GhError.
 */
export function parseJobLog(args: readonly string[], out: GhOutput): JobLog {
  if (out.exitCode === 0) return { kind: 'ready', log: out.stdout };
  if (out.exitCode !== AUTH_REQUIRED_EXIT && RUN_IN_PROGRESS.test(out.stderr.trim()))
    return { kind: 'not_yet' };
  throw failure(args, out);
}

/** An id from a caller goes into gh's arguments: refuse anything that is not an Actions id. */
function actionsId(kind: string, id: string, args: readonly string[]): void {
  if (!ACTIONS_ID.test(id))
    throw new GhError(
      GhFailure.Failed,
      `gh ${args.slice(0, 2).join(' ')} was given ${kind} id ${JSON.stringify(id.slice(0, 40))}, which is not a number`,
    );
}

/** A login is one word of letters, digits, hyphens and underscores; gh prints `null` for none. */
const GithubLogin = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,100}$/)
  .refine((login) => login !== 'null');

/** gh's JSON output is a boundary: parse it, and turn a surprise into a GhError. */
function parseOutput<S extends z.ZodType>(
  schema: S,
  args: readonly string[],
  text: string,
): z.output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GhError(
      GhFailure.Failed,
      `gh ${args.slice(0, 2).join(' ')} printed output that is not JSON`,
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new GhError(
      GhFailure.Failed,
      `gh ${args.slice(0, 2).join(' ')} printed output 10db can't read`,
    );
  return parsed.data;
}

export function createGh(exec: GhExec): Gh {
  async function ok(args: readonly string[], call: GhCall): Promise<string> {
    const out = await exec(args, call);
    if (out.exitCode !== 0) throw failure(args, out);
    return out.stdout;
  }
  return {
    async authStatus(call) {
      const out = await exec(['auth', 'status', '--active'], call);
      if (out.exitCode !== 0)
        throw new GhError(
          GhFailure.SignedOut,
          'gh is not signed in. Run gh auth login in a terminal.',
        );
    },
    async authLogin(call) {
      const args = ['api', 'user', '--jq', '.login'];
      const out = await exec(args, call);
      if (
        out.exitCode === AUTH_REQUIRED_EXIT ||
        (out.exitCode !== 0 && SIGNED_OUT.test(out.stderr))
      )
        return null;
      if (out.exitCode !== 0) throw failure(args, out);
      const login = GithubLogin.safeParse(out.stdout.trim());
      if (!login.success)
        throw new GhError(GhFailure.Failed, "gh api user printed a login 10db can't read");
      return login.data;
    },
    async prView({ repo, ref }, call) {
      const args = ['pr', 'view', ref, '-R', repo, '--json', 'url,state'];
      const out = await exec(args, call);
      if (out.exitCode !== 0 && NO_PR.test(out.stderr)) return null;
      if (out.exitCode !== 0) throw failure(args, out);
      return parseOutput(PrView, args, out.stdout);
    },
    async prStatus({ repo, ref }, call) {
      const args = [
        'pr',
        'view',
        ref,
        '-R',
        repo,
        '--json',
        'url,state,statusCheckRollup,headRefOid,mergeStateStatus',
      ];
      const out = await exec(args, call);
      if (out.exitCode !== 0 && (NO_PR.test(out.stderr) || PR_NOT_FOUND.test(out.stderr)))
        return null;
      if (out.exitCode !== 0) throw failure(args, out);
      const view = parseOutput(PrStatusView, args, out.stdout);
      return {
        url: view.url,
        state: view.state,
        headSha: view.headRefOid,
        mergeBlocked: view.mergeStateStatus,
        ...summariseChecks(view.statusCheckRollup ?? []),
      };
    },
    async prRequiredChecks({ repo, url }, call) {
      const args = [
        'pr',
        'checks',
        url,
        '-R',
        repo,
        '--required',
        '--json',
        'name,state,bucket,link,workflow,description',
      ];
      return parseRequiredChecks(args, await exec(args, call));
    },
    async jobLog({ repo, jobId }, call) {
      const args = ['run', 'view', '--job', jobId, '-R', repo, '--log-failed'];
      actionsId('job', jobId, args);
      return parseJobLog(args, await exec(args, call));
    },
    async rerunFailed({ repo, runId }, call) {
      const args = ['run', 'rerun', runId, '-R', repo, '--failed'];
      actionsId('run', runId, args);
      await ok(args, call);
    },
    async prCreate({ repo, base, head, title, bodyFile }, call) {
      const args = [
        'pr',
        'create',
        '-R',
        repo,
        '--base',
        base,
        '--head',
        head,
        '--title',
        title,
        '--body-file',
        bodyFile,
      ];
      // gh prints the new pull request's URL last; parse it, so a notice line is never recorded.
      const prUrl = prUrlIn(repo);
      const lines = (await ok(args, call)).split('\n').map((line) => line.trim());
      for (const line of lines.reverse()) {
        const url = prUrl.safeParse(line);
        if (url.success) return url.data;
      }
      throw new GhError(GhFailure.Failed, `gh pr create printed no pull request URL for ${repo}`);
    },
    async repoAllowsAutoMerge(repo, call) {
      const args = ['api', `repos/${repo}`];
      return parseOutput(RepoSettings, args, await ok(args, call)).allow_auto_merge;
    },
    async prAutoMerge({ repo, url }, call) {
      await ok(['pr', 'merge', url, '-R', repo, '--auto', '--squash'], call);
    },
    async prMerge({ repo, url }, call) {
      await ok(['pr', 'merge', url, '-R', repo, '--squash'], call);
    },
  };
}
