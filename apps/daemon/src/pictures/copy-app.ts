import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AppUrl, isDaemonAddress, type ProjectDto } from '@10db/contracts';
import type { TaskCopy } from './copy-task';
import type { SignInDeps, SignInProject } from './sign-in';
import { loginOutputTail } from './sign-in-output';
import { browserDir } from './storage-state';

// A separate copy's own app: the project's copy app command, run in the copy's folder under the gate's
// sandbox with the copy's id, starts the copy's app when it is not running and prints its address last.
// Pictures of the copy's work are then taken there, before it lands. Its output may name the copy's
// databases, so its log is kept as a dev login's is: 0600 under the data directory, removed once read.

/** The longest a copy's app may take to come up and print its address. */
const COPY_APP_TIMEOUT_MS = 120_000;

/** What running the copy app command needs of its project. */
export type CopyAppProject = SignInProject & Pick<ProjectDto, 'copyAppCommand'>;

export type CopyAppResult =
  | { readonly ok: true; readonly appUrl: AppUrl }
  | { readonly ok: false; readonly problem: string; readonly output: string };

/**
 * The copy's app address: the command's last non-empty line when it is a loopback origin off the
 * daemon's own port; null for anything else.
 */
export function copyAppAddress(output: string, daemonPort: number): AppUrl | null {
  const last = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1);
  if (last === undefined) return null;
  const parsed = AppUrl.safeParse(last);
  if (!parsed.success || isDaemonAddress(parsed.data, daemonPort)) return null;
  return parsed.data;
}

/** Runs the project's copy app command in the copy and reads the address it printed. */
export async function runCopyApp(
  deps: SignInDeps,
  project: CopyAppProject,
  copy: TaskCopy,
  daemonPort: number,
  signal: AbortSignal,
): Promise<CopyAppResult> {
  const command = project.copyAppCommand;
  if (command === null)
    return { ok: false, problem: 'The project has no copy app command', output: '' };
  const dir = browserDir(deps.dataDir, project.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logPath = join(dir, `copy-app-${String(deps.now())}.log`);
  // Made before the command runs, so the runner's write keeps this mode.
  closeSync(openSync(logPath, 'wx', 0o600));
  let printed: string;
  try {
    const result = await deps.gate.run({
      project: {
        repoPath: copy.folder,
        sandboxLoopback: project.sandboxLoopback,
        sandboxDocker: project.sandboxDocker,
      },
      command,
      logPath,
      timeoutMs: COPY_APP_TIMEOUT_MS,
      env: deps.sessionEnv(),
      rules: deps.rules(project),
      checkouts: deps.checkouts(),
      copyId: copy.copyId,
      signal,
    });
    if (result.timedOut)
      return {
        ok: false,
        problem: `The copy app command did not finish in ${String(COPY_APP_TIMEOUT_MS / 1000)} seconds`,
        output: loginOutputTail(result.tail),
      };
    if (result.aborted)
      return { ok: false, problem: 'The copy app command was stopped', output: '' };
    if (result.exitCode !== 0)
      return {
        ok: false,
        problem: `The copy app command failed (exit ${String(result.exitCode)})`,
        output: loginOutputTail(result.tail),
      };
    printed = readFileSync(logPath, 'utf8');
  } finally {
    rmSync(logPath, { force: true });
  }
  const appUrl = copyAppAddress(printed, daemonPort);
  if (appUrl === null)
    return {
      ok: false,
      problem: "The copy app command's last line is no app address on this Mac",
      output: loginOutputTail(printed),
    };
  // The shared app is not the copy's: its pictures would show the builder's folder, not the copy.
  if (appUrl === project.appUrl)
    return {
      ok: false,
      problem: "The copy app command printed the project's own app address",
      output: '',
    };
  return { ok: true, appUrl };
}
