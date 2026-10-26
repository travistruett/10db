import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLaneEnvFile, removeLaneEnvFile, SandboxTempDirError } from './index';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync('/tmp/sbe-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('lane env file', () => {
  it('holds only the export that turns git global config off, read-only to its owner', () => {
    const file = createLaneEnvFile(root);
    expect(dirname(file)).toBe(root);
    expect(readFileSync(file, 'utf8')).toBe('export GIT_CONFIG_GLOBAL=/dev/null\n');
    expect(statSync(file).mode & 0o777).toBe(0o400);
  });

  it('gives each session its own file', () => {
    expect(createLaneEnvFile(root)).not.toBe(createLaneEnvFile(root));
  });

  it('removes the file, and does nothing when it is already gone', () => {
    const file = createLaneEnvFile(root);
    removeLaneEnvFile(file, root);
    expect(existsSync(file)).toBe(false);
    expect(() => {
      removeLaneEnvFile(file, root);
    }).not.toThrow();
  });

  it.each([
    ['a file outside the root', (r: string) => join(r, 'x', '10db-env-a.sh')],
    ['a file without the prefix', (r: string) => join(r, 'other.sh')],
  ])('refuses to remove %s', (_name, pathIn) => {
    const path = pathIn(root);
    writeFileSync(join(root, 'other.sh'), 'x');
    expect(() => {
      removeLaneEnvFile(path, root);
    }).toThrow(SandboxTempDirError);
    expect(existsSync(join(root, 'other.sh'))).toBe(true);
  });
});
