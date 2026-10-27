import { singleQuoted } from './posix-quote';
import { SandboxProfileError } from './profile';
import { createSealedFile, removeSealedFile, type SealedFileKind } from './sealed-file';
import { LANE_TEMP_ROOT } from './temp-dir';

const ENV_FILE: SealedFileKind = { prefix: '10db-env-', suffix: '.sh', what: 'the lane env file' };
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what it finds
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * `NAME='value'` for each variable, quoted for the shell. A name that isn't a shell identifier or a
 * value with a control character is refused, naming the variable and never its value.
 */
export function shellAssignments(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env).map(([name, value]) => {
    if (!VARIABLE_NAME.test(name)) {
      throw new SandboxProfileError('env', 'a sandbox variable name is not a shell identifier');
    }
    if (CONTROL_CHARACTER.test(value)) {
      throw new SandboxProfileError('env', `${name} has a control character in its value`);
    }
    return `${name}=${singleQuoted(value)}`;
  });
}

/**
 * Writes one session's `CLAUDE_ENV_FILE`, which exports `env` and which the shell sources before
 * each command: Claude Code strips variables that point a tool at its config, `GIT_CONFIG_GLOBAL`
 * and `CARGO_HOME` among them, from a sandboxed command's env. The file is sealed (see
 * `createSealedFile`). Returns its path.
 */
export function createLaneEnvFile(
  env: Readonly<Record<string, string>>,
  root: string = LANE_TEMP_ROOT,
): string {
  const content = shellAssignments(env)
    .map((assignment) => `export ${assignment}\n`)
    .join('');
  return createSealedFile(root, ENV_FILE, content);
}

/** Removes a file made by `createLaneEnvFile`; refuses any other path. */
export function removeLaneEnvFile(file: string, root: string = LANE_TEMP_ROOT): void {
  removeSealedFile(file, root, ENV_FILE);
}
