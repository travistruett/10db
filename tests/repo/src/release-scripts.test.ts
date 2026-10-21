import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile, repoRoot } from './workspace';

const checkVersion = join(repoRoot, 'scripts/release/check-version.mjs');
const buildMacos = join(repoRoot, 'scripts/release/build-macos.sh');
// The file is repo-owned; the version is the only field read.
const current = (JSON.parse(readRepoFile('package.json')) as { version?: string }).version ?? '';

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', env });
}

const appleEnv = {
  APPLE_CERTIFICATE: 'x',
  APPLE_CERTIFICATE_PASSWORD: 'x',
  APPLE_API_KEY: 'x',
  APPLE_API_ISSUER: 'x',
  APPLE_TEAM_ID: 'x',
} as const;

describe('check-version.mjs', () => {
  it('passes when every version file matches, including the release-please manifest', () => {
    // The file is repo-owned; the root entry is the only field read.
    const manifest = JSON.parse(readRepoFile('.release-please-manifest.json')) as Record<
      string,
      string
    >;
    expect(manifest['.']).toBe(current);
    const result = run(process.execPath, [checkVersion, current]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('names every file that disagrees with the tag', () => {
    const result = run(process.execPath, [checkVersion, '9.9.9']);
    expect(result.status).toBe(1);
    for (const path of [
      'package.json',
      '.release-please-manifest.json',
      'apps/desktop/src-tauri/tauri.conf.json',
      'apps/desktop/src-tauri/Cargo.toml',
      'apps/desktop/src-tauri/Cargo.lock',
    ]) {
      expect(result.stderr).toContain(`${path}: version is ${current}, expected 9.9.9`);
    }
  });

  it('rejects a tag passed with its v prefix', () => {
    const result = run(process.execPath, [checkVersion, `v${current}`]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});

describe('build-macos.sh', () => {
  const bare = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' };

  it('rejects an unknown mode', () => {
    const result = run('bash', [buildMacos, 'notarized'], bare);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });

  it('refuses a signed build without the Apple credentials, before building anything', () => {
    const result = run('bash', [buildMacos, 'signed'], bare);
    expect(result.status).toBe(1);
    for (const name of [...Object.keys(appleEnv), 'APPLE_API_KEY_PATH']) {
      expect(result.stderr).toContain(`${name} is not set`);
    }
  });

  it('refuses a signed build when the API key file is missing', () => {
    const env = { ...bare, ...appleEnv, APPLE_API_KEY_PATH: join(repoRoot, 'no-such-key.p8') };
    const result = run('bash', [buildMacos, 'signed'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('APPLE_API_KEY_PATH does not point to a file');
  });

  it.each([
    { name: 'empty', content: '' },
    { name: 'a lone newline', content: '\n' },
    { name: 'not a private key', content: 'hunter2\n' },
  ])('refuses a signed build when the API key file is $name', ({ content }) => {
    const dir = mkdtempSync(join(tmpdir(), 'build-macos-key-'));
    try {
      const keyPath = join(dir, 'AuthKey.p8');
      writeFileSync(keyPath, content);
      const result = run('bash', [buildMacos, 'signed'], {
        ...bare,
        ...appleEnv,
        APPLE_API_KEY_PATH: keyPath,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('APPLE_API_KEY_PATH does not hold a private key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
