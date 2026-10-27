import { existsSync, realpathSync } from 'node:fs';
import { deniedEnvNames } from './env-allowlist';
import { SandboxProfileError } from './profile';
import { isEqualOrUnder } from './protected-reads';

/**
 * The PATH of the processes that run outside the sandbox: srt's host, the shell it starts the
 * sandbox from and `env`. System dirs only, never a dir a project can write.
 */
export const HOST_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** srt's own default temp dir, writable to every srt sandbox: closed, so runs share nothing. */
export const SRT_SHARED_TEMP = ['/tmp/claude', '/private/tmp/claude'];

/** Where srt's command-line host is, and the node that runs it. Neither lies where a project writes. */
export interface SandboxRuntime {
  readonly node: string;
  readonly cli: string;
}

/** The names of `env` a sandboxed command may inherit. */
export function allowlisted(env: Readonly<Record<string, string>>): Record<string, string> {
  const denied = new Set(deniedEnvNames(env));
  return Object.fromEntries(Object.entries(env).filter(([name]) => !denied.has(name)));
}

/**
 * Refuses an srt host or node that a project could write, as written or through a link: both run
 * outside the sandbox, so one a project swapped would run its code unsandboxed.
 */
export function checkRuntime(runtime: SandboxRuntime, writable: readonly string[]): void {
  for (const [what, path] of [
    ['node', runtime.node],
    ['command line', runtime.cli],
  ] as const) {
    const spellings = existsSync(path) ? [path, realpathSync(path)] : [path];
    if (spellings.some((spelling) => writable.some((root) => isEqualOrUnder(spelling, root)))) {
      throw new SandboxProfileError(
        'runtime',
        `srt's ${what} lies where a project can write: ${path}`,
      );
    }
  }
}
