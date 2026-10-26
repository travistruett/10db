import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { LANE_TEMP_ROOT, SandboxTempDirError } from './temp-dir';

const PREFIX = '10db-env-';

/**
 * Claude Code drops `GIT_CONFIG_GLOBAL` from a sandboxed command's env, and git then dies on the
 * denied `~/.gitconfig`; the shell sets it again from this file before each command.
 */
const CONTENT = 'export GIT_CONFIG_GLOBAL=/dev/null\n';

/**
 * Writes one session's `CLAUDE_ENV_FILE`, read-only (mode 0400), beside the lane temp dirs and
 * outside them, so no sandboxed command can write, replace or chmod it. Returns its path.
 */
export function createLaneEnvFile(root: string = LANE_TEMP_ROOT): string {
  const file = join(root, `${PREFIX}${randomBytes(6).toString('hex')}.sh`);
  try {
    // `wx` never follows a link or reuses a file someone else left at the name.
    writeFileSync(file, CONTENT, { flag: 'wx', mode: 0o400 });
  } catch {
    throw new SandboxTempDirError('Could not create the lane env file');
  }
  return file;
}

/** Removes a file made by `createLaneEnvFile`; refuses any other path. */
export function removeLaneEnvFile(file: string, root: string = LANE_TEMP_ROOT): void {
  if (dirname(file) !== root || !basename(file).startsWith(PREFIX)) {
    throw new SandboxTempDirError('Not a lane env file');
  }
  try {
    rmSync(file, { force: true });
  } catch {
    throw new SandboxTempDirError('Could not remove the lane env file');
  }
}
