import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  PageRoute,
  routeUrl,
  type AppUrl,
  type PermissionRuleDto,
  type ProjectDto,
} from '@10db/contracts';
import type { GateRunner } from '../verify';
import type { PageCamera } from './camera';
import { browserDir, writeStorageState, type StorageState } from './storage-state';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10, §13: signing the
// browser for pictures in. The builder's dev login command runs under the gate's sandbox, through the
// unslotted gate runner as a worktree's install does, with no project id, so it never turns the
// project's Docker on. Its output holds a sign-in token, so its log lies under the data directory,
// made 0600 before the command writes it, and is deleted once read; the address is never logged.

/** The longest a dev login may run. */
export const DEV_LOGIN_TIMEOUT_MS = 60_000;

export { browserDir };

/**
 * The address the dev login printed: its last line that is a route on the app or an absolute URL on
 * the app's own origin; null when it printed none.
 */
export function parseLoginUrl(appUrl: AppUrl, output: string): string | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (const line of lines.reverse()) {
    if (PageRoute.safeParse(line).success) return routeUrl(appUrl, line);
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

export type SignInResult =
  | { readonly ok: true; readonly state: StorageState }
  | { readonly ok: false; readonly problem: string };

const NEEDS_DOCKER = 'The dev login needs Docker: turn on Allow Docker in Settings › General';

/** Runs the project's dev login and opens what it printed; keeps the storage state it leads to. */
export async function signIn(
  deps: SignInDeps,
  project: SignInProject,
  signal: AbortSignal,
): Promise<SignInResult> {
  const { appUrl, devLoginCommand } = project;
  if (appUrl === null) return { ok: false, problem: 'The project has no app address' };
  if (devLoginCommand === null)
    return { ok: false, problem: 'The project has no dev login command' };
  const dir = browserDir(deps.dataDir, project.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logPath = join(dir, `login-${String(deps.now())}.log`);
  // Made before the command runs, so the runner's write keeps this mode.
  closeSync(openSync(logPath, 'wx', 0o600));
  let url: string | null;
  try {
    const result = await deps.gate.run({
      project: {
        repoPath: project.repoPath,
        sandboxLoopback: project.sandboxLoopback,
        sandboxDocker: project.sandboxDocker,
      },
      command: devLoginCommand,
      logPath,
      timeoutMs: DEV_LOGIN_TIMEOUT_MS,
      env: deps.sessionEnv(),
      rules: deps.rules(project),
      checkouts: deps.checkouts(),
      signal,
    });
    if (result.dockerRefused === true) return { ok: false, problem: NEEDS_DOCKER };
    if (result.timedOut)
      return {
        ok: false,
        problem: `The dev login command did not finish in ${String(DEV_LOGIN_TIMEOUT_MS / 1000)} seconds`,
      };
    if (result.aborted) return { ok: false, problem: 'The dev login was stopped' };
    if (result.exitCode !== 0)
      return {
        ok: false,
        problem: `The dev login command failed (exit ${String(result.exitCode)})`,
      };
    url = parseLoginUrl(appUrl, readFileSync(logPath, 'utf8'));
  } finally {
    rmSync(logPath, { force: true });
  }
  if (url === null)
    return { ok: false, problem: `The dev login command printed no address on ${appUrl}` };
  let state: StorageState;
  try {
    state = await deps.camera.signIn({ appUrl, url, signal });
  } catch {
    // The camera's words may carry the address, and with it the token: none of them is kept.
    return {
      ok: false,
      problem: 'The browser could not sign in at the address the dev login printed',
    };
  }
  writeStorageState(deps.dataDir, project.id, state);
  return { ok: true, state };
}
