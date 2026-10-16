import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { findOnPath, probeVersion, systemCheck, type LoginEnv } from './index';

let dir: { path: string; cleanup(): void };
beforeEach(() => {
  dir = tempDir('system-check');
});
afterEach(() => {
  dir.cleanup();
});

function tool(subdir: string, name: string, script: string, mode = 0o755): string {
  mkdirSync(join(dir.path, subdir), { recursive: true });
  const path = join(dir.path, subdir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, mode);
  return path;
}

describe('findOnPath', () => {
  it('returns the first executable match and skips non-executable files and empty entries', () => {
    tool('a', 'git', 'exit 0', 0o644);
    const second = tool('b', 'git', 'exit 0');
    expect(findOnPath('git', `::${join(dir.path, 'a')}:${join(dir.path, 'b')}`)).toBe(second);
  });

  it('returns null when nothing matches or PATH is unset', () => {
    expect(findOnPath('claude', join(dir.path, 'nowhere'))).toBeNull();
    expect(findOnPath('claude', undefined)).toBeNull();
  });
});

describe('probeVersion', () => {
  it('returns the first non-empty line of --version', async () => {
    const path = tool('bin', 'claude', 'echo; echo "2.1.299 (Claude Code)"; echo extra');
    expect(await probeVersion(path)).toBe('2.1.299 (Claude Code)');
  });

  it('returns null when the tool fails', async () => {
    expect(await probeVersion(tool('bin', 'docker', 'exit 1'))).toBeNull();
  });
});

describe('systemCheck', () => {
  it('reports each tool from the login PATH, with the login-env status', async () => {
    const claude = tool('bin', 'claude', 'exit 0');
    const git = tool('bin', 'git', 'exit 0');
    const login: LoginEnv = {
      vars: { PATH: join(dir.path, 'bin') },
      source: 'inherited',
      warning: 'The login shell timed out',
    };
    const report = await systemCheck(login, (path) => Promise.resolve(`version of ${path}`));
    expect(report).toEqual({
      loginEnv: { source: 'inherited', warning: 'The login shell timed out' },
      tools: [
        { name: 'claude', path: claude, version: `version of ${claude}`, required: true },
        { name: 'git', path: git, version: `version of ${git}`, required: true },
        { name: 'docker', path: null, version: null, required: false },
      ],
    });
  });
});
