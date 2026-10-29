import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareCommandEnv } from './command-env';
import { deniedEnvNames } from './env-allowlist';

let root: string;
let tmpDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-cmd-')));
  tmpDir = join(root, 'lane');
  mkdirSync(tmpDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('prepareCommandEnv tool-cache variables', () => {
  it("puts Apple's xcrun cache in the temp dir, where /usr/bin/git and make can create it", () => {
    const env = prepareCommandEnv(tmpDir, join(root, 'home'), {});
    expect(env['xcrun_db']).toBe(join(tmpDir, 'xcrun_db'));
  });

  it("keeps mise's logs to errors, as its tracked-config write can't land in the read-only state dir", () => {
    expect(prepareCommandEnv(tmpDir, join(root, 'home'), {})['MISE_LOG_LEVEL']).toBe('error');
  });

  it('sets only variables the env allowlist keeps for a sandboxed command', () => {
    const env = prepareCommandEnv(tmpDir, join(root, 'home'), {});
    expect(deniedEnvNames(env)).toEqual([]);
  });
});
