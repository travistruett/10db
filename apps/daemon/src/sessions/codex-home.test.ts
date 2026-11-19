import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
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
  permissions: z.looseObject({
    lane: z.looseObject({ filesystem: z.record(z.string(), z.string()) }),
  }),
  hooks: z.looseObject({
    PreToolUse: z.array(z.looseObject({ hooks: z.array(z.record(z.string(), z.unknown())) })),
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
      features: {
        network_proxy: true,
        goals: false,
        memories: false,
        apps: false,
        plugins: false,
        // Codex offers these by default; a lane needs none of them.
        image_generation: false,
        browser_use: false,
        browser_use_external: false,
        browser_use_full_cdp_access: false,
        computer_use: false,
        skill_mcp_dependency_install: false,
      },
      agents: { enabled: false },
      skills: { include_instructions: false },
      shell_environment_policy: { inherit: 'none' },
      // MCP sign-ins are kept in a file in this home, where the account's sessions read them.
      mcp_oauth_credentials_store: 'file',
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
});
