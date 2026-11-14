import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestStore, seedAccount, seedProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { createEventBus, createStateStore } from '../events';
import { FakeAdapter } from '../sessions';
import { createTrustServices } from './trust-services';

let root: TempDir;
let home: string;

beforeEach(() => {
  root = tempDir('trust-services');
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
        laneSandbox: null,
        adapter: new FakeAdapter({}),
        log: { warn: () => undefined },
      });
      expect((await trust.projectTrust(project.id)).preview.plugins).toEqual(plugins);
    } finally {
      test.close();
    }
  });
});
