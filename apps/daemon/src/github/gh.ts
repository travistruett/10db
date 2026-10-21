import { execFile } from 'node:child_process';
import { z } from 'zod';

/** One `gh` call: where it runs, in which environment, for how long, and how to stop it. */
export interface GhCall {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export const GhFailure = {
  NotInstalled: 'not_installed',
  SignedOut: 'signed_out',
  Timeout: 'timeout',
  Aborted: 'aborted',
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

/** The host integration (batch delivery spec §7): everything 10db asks GitHub, through the gh CLI. */
export interface Gh {
  authStatus(call: GhCall): Promise<void>;
  repoView(call: GhCall): Promise<string>;
  prView(
    input: { readonly repo: string; readonly ref: string },
    call: GhCall,
  ): Promise<PullRequest | null>;
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
const SIGNED_OUT = /gh auth login|not logged in/i;
const MAX_OUTPUT = 4 * 1024 * 1024;
/** Prompts are off whatever the environment says: nobody can answer one. */
const NO_PROMPTS = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const;

export const systemGhExec: GhExec = (args, call) =>
  new Promise((resolve, reject) => {
    execFile(
      'gh',
      [...args],
      {
        cwd: call.cwd,
        env: { ...call.env, ...NO_PROMPTS },
        timeout: call.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT,
        encoding: 'utf8',
        ...(call.signal ? { signal: call.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (call.signal?.aborted) {
          reject(new GhError(GhFailure.Aborted, 'gh was stopped'));
          return;
        }
        if (error.code === 'ENOENT') {
          reject(
            new GhError(
              GhFailure.NotInstalled,
              'gh is not installed or not on your login PATH. Install the GitHub CLI (brew install gh) and sign in with gh auth login.',
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

const RepoView = z.object({ nameWithOwner: z.string().regex(/^[^/\s]+\/[^/\s]+$/) });
const PrView = z.object({ url: z.url(), state: z.enum(PrState) });

function failure(args: readonly string[], out: GhOutput): GhError {
  if (out.exitCode === AUTH_REQUIRED_EXIT || SIGNED_OUT.test(out.stderr))
    return new GhError(
      GhFailure.SignedOut,
      'gh is not signed in. Run gh auth login in a terminal.',
    );
  return new GhError(
    GhFailure.Failed,
    `gh ${args.slice(0, 2).join(' ')} failed (exit ${String(out.exitCode)}): ${out.stderr.trim().slice(0, 500)}`,
  );
}

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

export function createGh(exec: GhExec = systemGhExec): Gh {
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
    async repoView(call) {
      const args = ['repo', 'view', '--json', 'nameWithOwner'];
      return parseOutput(RepoView, args, await ok(args, call)).nameWithOwner;
    },
    async prView({ repo, ref }, call) {
      const args = ['pr', 'view', ref, '-R', repo, '--json', 'url,state'];
      const out = await exec(args, call);
      if (out.exitCode !== 0 && NO_PR.test(out.stderr)) return null;
      if (out.exitCode !== 0) throw failure(args, out);
      return parseOutput(PrView, args, out.stdout);
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
      const url = (await ok(args, call))
        .split('\n')
        .map((line) => line.trim())
        .reverse()
        .find((line) => line.startsWith('https://'));
      if (url === undefined)
        throw new GhError(GhFailure.Failed, 'gh pr create printed no pull request URL');
      return url;
    },
  };
}
