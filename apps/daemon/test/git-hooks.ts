import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Hooks named `names` in `dir` that each run `program`. Stdin is closed, so a program that reads it
 * can't wait on a pipe git keeps open.
 */
export function writeHook(dir: string, names: readonly string[], program: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const hook = join(dir, name);
    writeFileSync(hook, `#!/bin/sh\nexec '${program}' < /dev/null\n`);
    chmodSync(hook, 0o755);
  }
}
