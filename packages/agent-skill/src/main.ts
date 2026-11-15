import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appDirIn, connectionFrom, httpApi } from './connection';
import { runCommand } from './commands';
import { TendbError, UnknownCommandError } from './errors';

/** The skill's own version, written beside this file by the build; null when running from source. */
function ownVersion(): string | null {
  try {
    return readFileSync(join(import.meta.dirname, 'VERSION'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

try {
  const conn = () => connectionFrom(appDirIn(homedir()), (path) => readFileSync(path, 'utf8'));
  const version = ownVersion();
  await runCommand(process.argv.slice(2), {
    // The connection is read per call, as the first call is the first need of it.
    api: (method, path, body) => httpApi(conn(), version)(method, path, body),
    out: (line) => {
      console.log(line);
    },
    cwd: process.cwd(),
    git: (args, cwd) => {
      try {
        return execFileSync('git', [...args], {
          cwd,
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null;
      }
    },
    readFile: (path) => readFileSync(path, 'utf8'),
    realpath: (path) => realpathSync(path),
  });
} catch (e) {
  console.error(
    e instanceof TendbError
      ? e.message
      : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(e instanceof UnknownCommandError ? 2 : 1);
}
