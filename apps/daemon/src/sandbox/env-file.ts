import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SandboxProfileError } from './profile';
import { LANE_TEMP_ROOT, SandboxTempDirError } from './temp-dir';

const PREFIX = '10db-env-';
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what it finds
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** `value` in POSIX single quotes, which the shell reads literally; a quote inside is spelled `'\''`. */
const singleQuoted = (value: string): string => `'${value.split("'").join("'\\''")}'`;

/**
 * One `export` line per variable. A name that isn't a shell identifier or a value with a control
 * character is refused, naming the variable and never its value.
 */
function exportLines(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([name, value]) => {
      if (!VARIABLE_NAME.test(name)) {
        throw new SandboxProfileError('env', 'a lane variable name is not a shell identifier');
      }
      if (CONTROL_CHARACTER.test(value)) {
        throw new SandboxProfileError('env', `${name} has a control character in its value`);
      }
      return `export ${name}=${singleQuoted(value)}\n`;
    })
    .join('');
}

/**
 * Writes one session's `CLAUDE_ENV_FILE`, which exports `env` and which the shell sources before
 * each command: Claude Code strips variables that point a tool at its config, `GIT_CONFIG_GLOBAL`
 * and `CARGO_HOME` among them, from a sandboxed command's env. The file is read-only (mode 0400),
 * beside the lane temp dirs and outside them, so no sandboxed command can write, replace or chmod
 * it. Returns its path.
 */
export function createLaneEnvFile(
  env: Readonly<Record<string, string>>,
  root: string = LANE_TEMP_ROOT,
): string {
  const content = exportLines(env);
  const file = join(root, `${PREFIX}${randomBytes(6).toString('hex')}.sh`);
  try {
    // `wx` never follows a link or reuses a file someone else left at the name.
    writeFileSync(file, content, { flag: 'wx', mode: 0o400 });
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
