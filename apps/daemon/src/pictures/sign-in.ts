import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  APP_URL_VARIABLE,
  PageRoute,
  routeUrl,
  type AppUrl,
  type PermissionRuleDto,
  type ProjectDto,
} from '@10db/contracts';
import type { GateResult, GateRunner } from '../verify';
import type { PageCamera } from './camera';
import type { TaskCopy } from './copy-task';
import { loginOutputTail } from './sign-in-output';
import { browserDir, writeStorageState, type StorageState } from './storage-state';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10, §13: signing the
// browser for pictures in. The builder's dev login command runs under the gate's sandbox, through the
// unslotted gate runner as a worktree's install does, with no project id, so it never turns the
// project's Docker on. Its output holds a sign-in token, so its log lies under the data directory,
// made 0600 before the command writes it, and is deleted once read; the address is never logged.

/** The longest a dev login may run. */
const DEV_LOGIN_TIMEOUT_MS = 60_000;

/** The roots a file path printed by a command starts with; a route of the app never does. */
const FILE_PATH =
  /^\/(Users|home|tmp|private|var|opt|etc|usr|Volumes|Library|System|Applications|root|nix)(\/|$)/;

/**
 * The address the dev login printed: its last line that is a route on the app (not a file path) or
 * an absolute http(s) URL on the app's own origin; null when it printed none.
 */
export function parseLoginUrl(appUrl: AppUrl, output: string): string | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (const line of lines.reverse()) {
    if (PageRoute.safeParse(line).success) {
      // A path a tool printed to its own files is no page of the app.
      if (FILE_PATH.test(line)) continue;
      return routeUrl(appUrl, line);
    }
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      continue;
    }
    if (url.origin === appUrl) return url.href;
  }
  return null;
}

/** What a dev login needs of its project. */
export type SignInProject = Pick<
  ProjectDto,
  'id' | 'repoPath' | 'sandboxLoopback' | 'sandboxDocker' | 'appUrl' | 'devLoginCommand'
>;

export interface SignInDeps {
  /** The unslotted gate runner, as a worktree's install uses. */
  readonly gate: GateRunner;
  readonly camera: Pick<PageCamera, 'signIn'>;
  readonly dataDir: string;
  /** Epoch milliseconds, naming the log. */
  readonly now: () => number;
  readonly sessionEnv: () => Readonly<Record<string, string>>;
  readonly rules: (
    project: SignInProject,
  ) => readonly Pick<PermissionRuleDto, 'toolName' | 'pattern'>[];
  readonly checkouts: () => readonly string[];
}

/** Where a sign-in stopped: before the command ran, in the command, or in the browser opening its address. */
export const SignInStep = { Setup: 'setup', Command: 'command', Browser: 'browser' } as const;
export type SignInStep = (typeof SignInStep)[keyof typeof SignInStep];

export type SignInResult =
  | { readonly ok: true; readonly state: StorageState }
  | {
      readonly ok: false;
      readonly problem: string;
      readonly step: SignInStep;
      /** The command's exit code; null when it did not run to an end. */
      readonly exitCode: number | null;
      /** The last lines the command printed, masked; empty when it printed none. */
      readonly output: string;
    };

const failed = (
  step: SignInStep,
  problem: string,
  run: { readonly exitCode: number | null; readonly output: string } = {
    exitCode: null,
    output: '',
  },
): SignInResult => ({ ok: false, problem, step, ...run });

const NEEDS_DOCKER = 'The dev login needs Docker: turn on Allow Docker in Settings › Sandbox';

/** What went wrong with a dev login's run, in the status line's words; null for one that passed. */
export function devLoginProblem(
  result: Pick<GateResult, 'exitCode' | 'timedOut' | 'aborted' | 'dockerRefused'>,
): string | null {
  if (result.dockerRefused === true) return NEEDS_DOCKER;
  if (result.timedOut)
    return `The dev login command did not finish in ${String(DEV_LOGIN_TIMEOUT_MS / 1000)} seconds`;
  if (result.aborted) return 'The dev login was stopped';
  if (result.exitCode !== 0)
    return `The dev login command failed (exit ${String(result.exitCode)})`;
  return null;
}

/**
 * Where a picture is taken: the project's shared app, or a separate copy's own app, whose dev login
 * runs in the copy's folder with the copy's id so it signs in to the copy's databases.
 */
export interface PictureSite {
  readonly appUrl: AppUrl;
  readonly copy: TaskCopy | null;
}

/**
 * Runs the project's dev login and opens what it printed; keeps the storage state it leads to. The
 * command is told the address it signs in on (`TENDB_APP_URL`), and for a copy the copy's id too.
 */
export async function signIn(
  deps: SignInDeps,
  project: SignInProject,
  signal: AbortSignal,
  site?: PictureSite,
): Promise<SignInResult> {
  const { devLoginCommand } = project;
  const appUrl = site?.appUrl ?? project.appUrl;
  const copy = site?.copy ?? null;
  if (appUrl === null) return failed(SignInStep.Setup, 'The project has no app address');
  if (devLoginCommand === null)
    return failed(SignInStep.Setup, 'The project has no dev login command');
  const dir = browserDir(deps.dataDir, project.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logPath = join(dir, `login-${String(deps.now())}.log`);
  // Made before the command runs, so the runner's write keeps this mode.
  closeSync(openSync(logPath, 'wx', 0o600));
  let url: string | null;
  let printed: string;
  try {
    const result = await deps.gate.run({
      project: {
        repoPath: copy?.folder ?? project.repoPath,
        sandboxLoopback: project.sandboxLoopback,
        sandboxDocker: project.sandboxDocker,
      },
      command: devLoginCommand,
      logPath,
      timeoutMs: DEV_LOGIN_TIMEOUT_MS,
      env: { ...deps.sessionEnv(), [APP_URL_VARIABLE]: appUrl },
      rules: deps.rules(project),
      checkouts: deps.checkouts(),
      copyId: copy?.copyId ?? null,
      signal,
    });
    const problem = devLoginProblem(result);
    if (problem !== null)
      return failed(SignInStep.Command, problem, {
        exitCode: result.timedOut || result.aborted ? null : result.exitCode,
        output: loginOutputTail(result.tail),
      });
    printed = readFileSync(logPath, 'utf8');
    url = parseLoginUrl(appUrl, printed);
  } finally {
    rmSync(logPath, { force: true });
  }
  if (url === null)
    return failed(SignInStep.Command, `The dev login command printed no address on ${appUrl}`, {
      exitCode: 0,
      output: loginOutputTail(printed),
    });
  let state: StorageState;
  try {
    state = await deps.camera.signIn({ appUrl, url, signal });
  } catch {
    // The camera's words may carry the address, and with it the token: none of them is kept.
    return failed(
      SignInStep.Browser,
      'The browser could not sign in at the address the dev login printed',
      { exitCode: 0, output: '' },
    );
  }
  writeStorageState(deps.dataDir, project.id, state, copy?.copyId ?? null);
  return { ok: true, state };
}

/** At start-up: removes the dev login logs a stopped daemon left; they hold sign-in tokens. */
export function sweepLoginLogs(dataDir: string): number {
  const root = join(dataDir, 'browser');
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const name of readdirSync(join(root, project.name)))
      if (/^(login|copy-app)-\d+\.log$/.test(name)) {
        rmSync(join(root, project.name, name), { force: true });
        removed += 1;
      }
  }
  return removed;
}
