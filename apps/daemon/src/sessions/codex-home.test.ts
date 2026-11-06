import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { singleQuoted } from '../sandbox';
import { CODEX_HOOK_TIMEOUT_SECONDS, codexHomes, GUARD_HOOK_EVENT } from './codex-home';

const dirs: TempDir[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup();
});

/** A home and a checkout, both under a folder whose name has a space. */
function setup(): { home: string; checkout: string } {
  const root = tempDir('codex home');
  dirs.push(root);
  const base = join(root.path, 'with space');
  const home = join(base, 'codex-home');
  const checkout = join(base, 'checkout');
  mkdirSync(checkout, { recursive: true });
  return { home, checkout: realpathSync(checkout) };
}

/** The parts of config.toml the tests read; the rest passes through untouched. */
const TestConfig = z.looseObject({
  projects: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  allow_login_shell: z.boolean().optional(),
  permissions: z.looseObject({
    lane: z.looseObject({ filesystem: z.record(z.string(), z.string()) }),
  }),
  hooks: z.looseObject({
    PreToolUse: z.array(z.looseObject({ hooks: z.array(z.record(z.string(), z.unknown())) })),
    state: z.record(z.string(), z.unknown()).optional(),
  }),
});

const readConfig = (home: string): z.infer<typeof TestConfig> =>
  TestConfig.parse(parse(readFileSync(join(home, 'config.toml'), 'utf8')));

describe('codex home', () => {
  it('writes the template and the guard hook', async () => {
    const { home, checkout } = setup();
    await codexHomes()(home).prepare(checkout);
    const config = readConfig(home);
    expect(config).toMatchObject({
      forced_login_method: 'chatgpt',
      default_permissions: 'lane',
      allow_login_shell: false,
      web_search: 'disabled',
      features: { network_proxy: true, goals: false, memories: false, apps: false, plugins: false },
      agents: { enabled: false },
      skills: { include_instructions: false },
      shell_environment_policy: { inherit: 'none' },
    });
    expect(config.permissions.lane.filesystem).toEqual({ ':minimal': 'read' });
    expect(config.hooks.PreToolUse[0]?.hooks[0]).toMatchObject({
      type: 'command',
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
      command: `/bin/sh '${home}/guard-hook.sh'`,
    });
    expect(CODEX_HOOK_TIMEOUT_SECONDS).toBe(15_000);
    expect(GUARD_HOOK_EVENT).toBe('preToolUse');
    expect(config.projects[checkout]).toEqual({ trust_level: 'untrusted' });
    expect(readFileSync(join(home, 'guard-hook.sh'), 'utf8')).toContain(
      '--unix-socket "$TENDB_GUARD_SOCKET"',
    );
  });

  it('pins the real path of a checkout reached through a link', async () => {
    const { home, checkout } = setup();
    const link = join(checkout, '..', 'link');
    symlinkSync(checkout, link);
    await codexHomes()(home).prepare(link);
    expect(Object.keys(readConfig(home).projects)).toEqual([checkout]);
  });

  it('replaces a trusted entry Codex wrote with untrusted', async () => {
    const { home, checkout } = setup();
    const homes = codexHomes();
    await homes(home).prepare(checkout);
    const config = readConfig(home);
    config.projects[checkout] = { trust_level: 'trusted' };
    writeFileSync(join(home, 'config.toml'), stringify(config));
    await homes(home).prepare(checkout);
    expect(readConfig(home).projects[checkout]).toEqual({ trust_level: 'untrusted' });
  });

  it('keeps the projects entries of other checkouts', async () => {
    const { home, checkout } = setup();
    const homes = codexHomes();
    await homes(home).prepare(checkout);
    const config = readConfig(home);
    config.projects['/elsewhere'] = { trust_level: 'trusted' };
    writeFileSync(join(home, 'config.toml'), stringify(config));
    await homes(home).prepare(checkout);
    expect(readConfig(home).projects['/elsewhere']).toEqual({ trust_level: 'trusted' });
  });

  it('pins two checkouts prepared at once', async () => {
    const { home, checkout } = setup();
    const second = join(checkout, '..', 'second');
    mkdirSync(second);
    const realSecond = realpathSync(second);
    const homes = codexHomes();
    await Promise.all([homes(home).prepare(checkout), homes(home).prepare(second)]);
    expect(Object.keys(readConfig(home).projects).sort()).toEqual([checkout, realSecond].sort());
  });

  it('keeps the trust hash when it rewrites the file', async () => {
    const { home, checkout } = setup();
    const homes = codexHomes();
    await homes(home).prepare(checkout);
    await homes(home).trustGuardHook('guard-key', 'sha256:abc');
    const config = readConfig(home);
    config.allow_login_shell = true;
    writeFileSync(join(home, 'config.toml'), stringify(config));
    await homes(home).prepare(checkout);
    expect(readConfig(home).hooks.state?.['guard-key']).toEqual({ trusted_hash: 'sha256:abc' });
    expect(readConfig(home).allow_login_shell).toBe(false);
  });

  it('does not rewrite a file that already matches', async () => {
    const { home, checkout } = setup();
    const homes = codexHomes();
    await homes(home).prepare(checkout);
    const before = [
      statSync(join(home, 'config.toml')).ino,
      statSync(join(home, 'guard-hook.sh')).ino,
    ];
    await homes(home).prepare(checkout);
    const after = [
      statSync(join(home, 'config.toml')).ino,
      statSync(join(home, 'guard-hook.sh')).ino,
    ];
    expect(after).toEqual(before);
  });

  it('makes guard-hook.sh executable and the home mode 700', async () => {
    const { home, checkout } = setup();
    const homes = codexHomes();
    const codexHome = homes(home);
    await codexHome.prepare(checkout);
    expect(statSync(join(home, 'guard-hook.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(codexHome.emptyHome).isDirectory()).toBe(true);
  });

  it('quotes a home path that holds a single quote', async () => {
    const root = tempDir("codex 'home'");
    dirs.push(root);
    const home = join(root.path, "it's here");
    const checkout = join(root.path, 'checkout');
    mkdirSync(checkout);
    await codexHomes()(home).prepare(checkout);
    const command = readConfig(home).hooks.PreToolUse[0]?.hooks[0]?.['command'];
    expect(command).toBe(`/bin/sh ${singleQuoted(join(home, 'guard-hook.sh'))}`);
    // The shell finds the script: it runs and refuses the call (exit 2) as it does with no socket.
    const run = spawnSync('/bin/sh', ['-c', String(command)], { env: {}, encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('10db could not check this call');
  });
});
