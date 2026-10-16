import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolatedGitEnvironment } from './fixtures';
import { manifestPaths, readManifest, readRepoFile, repoRoot } from './workspace';

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const EXACT_PIN = new RegExp(
  String.raw`^(?:${SEMVER}|workspace:\*|npm:(?:@[\w.-]+/)?[\w.-]+@${SEMVER})$`,
);

/** The version mise.toml pins for a tool written as `name = "x.y.z"`. */
function misePin(tool: string): string | undefined {
  return new RegExp(`^${tool} = "([^"]+)"$`, 'm').exec(readRepoFile('mise.toml'))?.[1];
}

describe('dependency pins', () => {
  it.each(manifestPaths())('%s pins every dependency exactly', (path) => {
    const manifest = readManifest(path);
    const all = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    };
    const loose = Object.entries(all).filter(([, spec]) => !EXACT_PIN.test(spec));
    expect(loose).toEqual([]);
  });

  it('marks every workspace package private and ESM', () => {
    const offenders = manifestPaths()
      .map((path) => ({ path, manifest: readManifest(path) }))
      .filter(({ manifest }) => manifest.private !== true || manifest.type !== 'module')
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('holds new releases for a day and runs only allowlisted install scripts', () => {
    const workspace = readRepoFile('pnpm-workspace.yaml');
    expect(workspace).toMatch(/^minimumReleaseAge: 1440$/m);
    expect(workspace).toMatch(/^strictDepBuilds: true$/m);
    expect(workspace).toMatch(/^allowBuilds:$/m);
  });
});

describe('toolchain', () => {
  it('pins Node in mise.toml and engines, with no .node-version', () => {
    const pinned = misePin('node');
    expect(pinned).toMatch(/^26\.\d+\.\d+$/);
    expect(readManifest('package.json').engines?.node).toBe(pinned);
    expect(existsSync(resolve(repoRoot, '.node-version'))).toBe(false);
  });

  it('pins the same pnpm in mise.toml and packageManager', () => {
    expect(misePin('pnpm')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readManifest('package.json').packageManager).toBe(`pnpm@${misePin('pnpm') ?? ''}`);
  });

  it('pins the same Rust in mise.toml and rust-toolchain.toml', () => {
    const mise = /^rust = \{ version = "([^"]+)"/m.exec(readRepoFile('mise.toml'))?.[1];
    const toolchain = /^channel = "([^"]+)"$/m.exec(readRepoFile('rust-toolchain.toml'))?.[1];
    expect(mise).toMatch(/^\d+\.\d+\.\d+$/);
    expect(toolchain).toBe(mise);
  });

  it('pins every mise tool exactly and locks each one', () => {
    const tools = /\[tools\]\n([\s\S]*?)(?:\n\[|$)/.exec(readRepoFile('mise.toml'))?.[1] ?? '';
    const entries = tools.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
    const exact = /^[\w-]+ = (?:"\d+\.\d+\.\d+"|\{ version = "\d+\.\d+\.\d+"[^}]*\})$/;
    expect(entries.filter((line) => !exact.test(line))).toEqual([]);
    const lock = readRepoFile('mise.lock');
    const names = entries.map((line) => line.split(' ')[0] ?? '');
    expect(names.filter((name) => !lock.includes(`[[tools.${name}]]`))).toEqual([]);
  });

  it('runs tsc from TypeScript 7 and exposes the TypeScript 6 API to tools', async () => {
    const ts = await import('typescript');
    expect(ts.version).toMatch(/^6\.0\./);
    const native = readManifest('package.json').devDependencies?.['@typescript/native'];
    expect(native).toMatch(/^npm:typescript@7\./);
  });

  it('keeps .env files out of git, except the committed example', () => {
    const ignored = (path: string) =>
      spawnSync('git', ['check-ignore', '-q', path], {
        cwd: repoRoot,
        env: isolatedGitEnvironment(),
      }).status === 0;
    expect(ignored('apps/daemon/.env')).toBe(true);
    expect(ignored('apps/daemon/.env.local')).toBe(true);
    expect(ignored('apps/daemon/.env.example')).toBe(false);
  });

  it('loads the daemon .env.example variables into the dev server when .env exists', () => {
    const { scripts } = JSON.parse(readRepoFile('apps/daemon/package.json')) as {
      scripts: Record<string, string>;
    };
    expect(scripts['dev']).toContain('--env-file-if-exists=.env');
  });
});
