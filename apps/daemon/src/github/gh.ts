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
}

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

const PrStatusView = z.object({
  url: z.url(),
  state: z.enum(PrState),
  headRefOid: z
    .string()
    .nullish()
    .transform((oid) => (oid === undefined || oid === null || oid === '' ? null : oid)),
  statusCheckRollup: z.array(z.unknown().transform(rollupEntry)).nullish(),
});

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
        'url,state,statusCheckRollup,headRefOid',
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
        ...summariseChecks(view.statusCheckRollup ?? []),
      };
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
  };
}
