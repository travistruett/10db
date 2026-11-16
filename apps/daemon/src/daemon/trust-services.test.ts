import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestStore, seedAccount, seedProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homeOutsideTemp, type TempDir } from '../../test/fixtures';
import { createEventBus, createStateStore } from '../events';
import { signInCandidates } from '../accounts';
import { FakeAdapter } from '../sessions';
import { createTrustServices } from './trust-services';

let root: TempDir;
let home: string;

beforeEach(() => {
  root = homeOutsideTemp('trust-services');
  home = join(root.path, 'home');
  const plugin = join(home, '.claude/plugins/cache/m/p/1');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'p' }));
  writeFileSync(
    join(home, '.claude/plugins/installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'p@m': [
          {
            scope: 'user',
            installPath: plugin,
            version: '1',
            installedAt: '2026-11-01T00:00:00.000Z',
            lastUpdated: '2026-11-01T00:00:00.000Z',
            gitCommitSha: 'abc',
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(home, '.claude/settings.json'),
    JSON.stringify({ enabledPlugins: { 'p@m': true } }),
  );
});

afterEach(() => {
  root.cleanup();
});

describe('the Comes along preview', () => {
  it.each([
    ['a Claude project lists the plugin', undefined, ['p@m']],
    [
      'a Codex project lists only what Codex takes of it, its skills',
      { kind: 'codex_signin', label: 'ChatGPT plan' } as const,
      ['p@m (its skills only)'],
    ],
  ])('%s', async (_name, account, plugins) => {
    const test = createTestStore();
    try {
      const state = createStateStore(test.store, createEventBus());
      const accountId = account === undefined ? undefined : seedAccount(test.store, account).id;
      const project = seedProject(test.store, {
        repoPath: join(root.path, 'repo'),
        ...(accountId === undefined ? {} : { accountId }),
      });
      const trust = createTrustServices({
        state,
        builderHome: home,
        laneWritableRoots: [],
        worktreeBase: join(root.path, 'worktrees'),
        login: { configDir: () => null, codexHome: () => null },
        laneSandbox: null,
        adapter: new FakeAdapter({}),
        judge: { ready: () => Promise.resolve(false) },
        log: { warn: () => undefined },
        loginEnv: () => ({}),
      });
      expect((await trust.projectTrust(project.id)).preview.plugins).toEqual(plugins);
    } finally {
      test.close();
    }
  });
});

describe("the builder's MCP servers notice", () => {
  it.each<[() => string | null, () => string | null, string | null]>([
    [() => null, () => null, null],
    [
      () => '/elsewhere',
      () => null,
      'Your shell sets CLAUDE_CONFIG_DIR. 10db reads your servers from ~/.claude.json, not from there.',
    ],
    [
      () => '/elsewhere',
      () => '/codex',
      'Your shell sets CLAUDE_CONFIG_DIR. 10db reads your servers from ~/.claude.json, not from there. Your shell sets CODEX_HOME. 10db reads your servers from ~/.codex/config.toml, not from there.',
    ],
  ])('says what the shell sets that 10db does not follow', async (configDir, codexHome, notice) => {
    const test = createTestStore();
    try {
      const trust = createTrustServices({
        state: createStateStore(test.store, createEventBus()),
        builderHome: home,
        laneWritableRoots: [],
        worktreeBase: join(root.path, 'worktrees'),
        login: { configDir, codexHome },
        laneSandbox: null,
        adapter: new FakeAdapter({}),
        judge: { ready: () => Promise.resolve(false) },
        log: { warn: () => undefined },
        loginEnv: () => ({}),
      });
      expect((await trust.trustSettings()).mcpNotice).toBe(notice);
    } finally {
      test.close();
    }
  });
});

describe("the app-wide plan of the builder's servers", () => {
  it('holds the approved servers only, and the sign-in candidates are those that send no headers', async () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          linear: { type: 'http', url: 'https://linear.example/mcp' },
          docs: { type: 'http', url: 'https://docs.example/mcp', headers: { 'X-Key': 'k' } },
          pending: { type: 'http', url: 'https://pending.example/mcp' },
        },
      }),
    );
    const test = createTestStore();
    try {
      const trust = createTrustServices({
        state: createStateStore(test.store, createEventBus()),
        builderHome: home,
        laneWritableRoots: [],
        worktreeBase: join(root.path, 'worktrees'),
        login: { configDir: () => null, codexHome: () => null },
        laneSandbox: null,
        adapter: new FakeAdapter({}),
        judge: { ready: () => Promise.resolve(false) },
        log: { warn: () => undefined },
        loginEnv: () => ({}),
      });
      expect(Object.keys(trust.appMcpPlan().remote)).toEqual([]);
      const listed = (await trust.trustSettings()).mcpServers;
      for (const name of ['linear', 'docs']) {
        const server = listed.find((candidate) => candidate.name === name);
        if (server?.configHash == null) throw new Error(`${name} was not listed`);
        await trust.approveYourMcpServer({ key: server.key, configHash: server.configHash });
      }
      const plan = trust.appMcpPlan();
      expect(Object.keys(plan.remote).sort()).toEqual(['docs', 'linear']);
      expect(signInCandidates(plan).map((candidate) => candidate.name)).toEqual(['linear']);
    } finally {
      test.close();
    }
  });
});

describe("the builder's config files and the lane's writable roots", () => {
  it('lists no server from a file that leads into the worktree base, which a lane writes and the launch refuses', async () => {
    const outside = homeOutsideTemp('trust-services-roots');
    const test = createTestStore();
    try {
      const worktrees = join(outside.path, 'worktrees');
      const builderHome = join(outside.path, 'home');
      mkdirSync(worktrees, { recursive: true });
      mkdirSync(builderHome, { recursive: true });
      writeFileSync(
        join(worktrees, 'shared.json'),
        JSON.stringify({
          mcpServers: { linear: { type: 'http', url: 'https://linear.example/mcp' } },
        }),
      );
      symlinkSync(join(worktrees, 'shared.json'), join(builderHome, '.claude.json'));
      const trust = createTrustServices({
        state: createStateStore(test.store, createEventBus()),
        builderHome,
        laneWritableRoots: [],
        worktreeBase: worktrees,
        login: { configDir: () => null, codexHome: () => null },
        laneSandbox: null,
        adapter: new FakeAdapter({}),
        judge: { ready: () => Promise.resolve(false) },
        log: { warn: () => undefined },
        loginEnv: () => ({}),
      });
      expect((await trust.trustSettings()).mcpServers.map((server) => server.name)).toEqual([]);
    } finally {
      test.close();
      outside.cleanup();
    }
  });
});
