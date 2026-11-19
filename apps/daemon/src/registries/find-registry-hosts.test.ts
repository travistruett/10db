import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { findRegistryHosts } from './index';

const dirs: TempDir[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup();
});

/** A project folder holding `files` (relative path to text). */
function project(files: Readonly<Record<string, string>>): string {
  const dir = tempDir('registries');
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir.path, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return dir.path;
}

describe('findRegistryHosts', () => {
  it('allows a private registry by host only: the token in its URL is never returned', async () => {
    const root = project({
      '.npmrc':
        'registry=https://deploy:s3cr3t-token@npm.corp.example.com:8443/path/s3cr3t-token/\n',
      'Cargo.lock': 'source = "sparse+https://u:cargo-secret@cargo.corp.example.com/index/"\n',
    });
    const found = await findRegistryHosts(root);
    expect(found.map((f) => f.host).sort()).toEqual([
      'cargo.corp.example.com',
      'npm.corp.example.com',
    ]);
    expect(JSON.stringify(found)).not.toMatch(/s3cr3t|cargo-secret|deploy|8443/);
  });

  it('keeps only the host of an escaped URL: no password, user name or path', async () => {
    const root = project({
      '.npmrc':
        'registry=https://pkgs.dev.azure.com/acme/My%20Project/_packaging/feed/npm/registry/\n',
      'pip.conf': '[global]\nindex-url = https://deploy:p%40ss@pypi.corp.example.com/simple\n',
    });
    const found = await findRegistryHosts(root);
    expect(found.map((f) => f.host).sort()).toEqual([
      'pkgs.dev.azure.com',
      'pypi.corp.example.com',
    ]);
    expect(JSON.stringify(found)).not.toMatch(/p%40ss|p@ss|deploy|acme|My|_packaging|simple/);
  });
});
