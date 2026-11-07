import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getBatch } from '@10db/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { pathOf } from '../../test/delivery-worlds';
import { createBaseUpdates } from './base-update';
import { createDependencyChanges } from './dependency-change';

vi.setConfig({ testTimeout: 120_000 });

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

const signal = new AbortController().signal;

const LOCKFILE = [
  'importers:',
  '  .:',
  '    dependencies:',
  '      left-pad:',
  '        specifier: 1.3.0',
  '        version: 1.3.0',
  '',
].join('\n');

const manifest = (dependencies: Record<string, string>): string =>
  `${JSON.stringify({ name: 'app', version: '1.0.0', dependencies }, null, 2)}\n`;

/** A project with a manifest and a lockfile on main and a cut copy; the lane then edits its package.json. */
async function lane(edited: Record<string, string>) {
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
  h.commit('.gitignore', 'node_modules/\n');
  h.commit('package.json', manifest({}));
  h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  h.git$('push', '-q', 'origin', 'main');
  mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
  const started = h.starter.startTask(h.addTask('Alpha').id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  const file = join(pathOf(batch), 'package.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, manifest(edited));
  const changes = createDependencyChanges(h.ctx, createBaseUpdates(h.ctx));
  return { batch, changes, path: pathOf(batch) };
}

describe('installing a lane’s dependency change in its copy', () => {
  it('resolves and installs a pinned dependency the lane added, so the lockfile changes and every package resolves', async () => {
    const { batch, changes, path } = await lane({ 'left-pad': '1.3.0' });
    const before = h.pnpm.calls().length;
    h.pnpm.makes({
      'pnpm-lock.yaml': LOCKFILE,
      'node_modules/left-pad/index.js': 'module.exports = 1;\n',
    });
    const result = await changes.install(batch.id, signal);
    expect(result).toMatchObject({ kind: 'installed' });
    expect(result.kind === 'installed' && result.changed).toEqual(
      expect.arrayContaining(['package.json', 'pnpm-lock.yaml']),
    );
    expect(h.pnpm.calls()).toHaveLength(before + 1);
    expect(h.pnpm.calls().at(-1)).toContain('install --no-frozen-lockfile --ignore-scripts');
    expect(readFileSync(join(path, 'pnpm-lock.yaml'), 'utf8')).toBe(LOCKFILE);
  });

  it.each(['^1.3.0', '~1.3.0', '*', 'latest', '>=1', '1.x'])(
    'refuses %s: a dependency is pinned exactly, and runs no install',
    async (range) => {
      const { batch, changes } = await lane({ 'left-pad': range });
      const before = h.pnpm.calls().length;
      const result = await changes.install(batch.id, signal);
      expect(result).toMatchObject({ kind: 'refused' });
      expect(result.kind === 'refused' && result.reason).toContain(`left-pad (${range})`);
      expect(result.kind === 'refused' && result.reason).toContain('package.json');
      expect(h.pnpm.calls()).toHaveLength(before);
    },
  );

  it('lets workspace and catalog references through unpinned', async () => {
    const { batch, changes } = await lane({ other: 'workspace:*', shared: 'catalog:' });
    h.pnpm.makes({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
    expect((await changes.install(batch.id, signal)).kind).toBe('installed');
  });

  it('does not hold a dependency the lane left as it was to the pin rule', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    h.commit('.gitignore', 'node_modules/\n');
    h.commit('package.json', manifest({ old: '^2.0.0' }));
    h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    h.git$('push', '-q', 'origin', 'main');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    const started = h.starter.startTask(h.addTask('Alpha').id);
    await h.jobs.idle();
    const batch = getBatch(h.store.db, started.id);
    writeFileSync(
      join(pathOf(batch), 'package.json'),
      manifest({ old: '^2.0.0', 'left-pad': '1.3.0' }),
    );
    const changes = createDependencyChanges(h.ctx, createBaseUpdates(h.ctx));
    expect(await changes.install(batch.id, signal)).toMatchObject({ kind: 'installed' });
  });

  it('says the install failed, with its log, when pnpm does', async () => {
    const { batch, changes } = await lane({ 'left-pad': '1.3.0' });
    h.pnpm.failWith(1, 'ERR_PNPM_NO_MATCHING_VERSION left-pad');
    const result = await changes.install(batch.id, signal);
    expect(result).toMatchObject({ kind: 'failed' });
    expect(result.kind === 'failed' && result.summary).toContain('ERR_PNPM_NO_MATCHING_VERSION');
    expect(result.kind === 'failed' && result.logPath).toMatch(/\.log$/);
  });

  it('says so when the install ran but a package does not resolve afterwards', async () => {
    const { batch, changes } = await lane({ 'left-pad': '1.3.0' });
    h.pnpm.makes({ 'pnpm-lock.yaml': LOCKFILE });
    const result = await changes.install(batch.id, signal);
    expect(result).toMatchObject({ kind: 'failed' });
    expect(result.kind === 'failed' && result.summary).toContain('left-pad');
    expect(result.kind === 'failed' && result.summary).toContain('do not resolve');
  });

  it('leaves the install-repaired notice when refresh’s own start over brings a failed install back', async () => {
    const { batch, changes } = await lane({ 'left-pad': '1.3.0' });
    const first = h.pnpm.calls().length + 1;
    h.pnpm.makes({ 'pnpm-lock.yaml': LOCKFILE });
    h.pnpm.failsOnCall(first, 'ERR_PNPM_FETCH_403');
    h.pnpm.makesOnCall(first + 1, { 'node_modules/left-pad/index.js': 'module.exports = 1;\n' });
    expect(await changes.install(batch.id, signal)).toMatchObject({ kind: 'installed' });
    const notice = h.only(getBatch(h.store.db, batch.id).notices);
    expect(notice).toMatchObject({ key: 'install-repaired', tone: 'info' });
    expect(notice.body).toContain('left-pad');
  });

  it('leaves no notice when the start over exits non-zero: the lane is told the install failed', async () => {
    const { batch, changes } = await lane({ 'left-pad': '1.3.0' });
    const first = h.pnpm.calls().length + 1;
    h.pnpm.makes({ 'pnpm-lock.yaml': LOCKFILE });
    h.pnpm.failWith(1, 'ERR_PNPM_FETCH_403');
    h.pnpm.makesOnCall(first + 1, { 'node_modules/left-pad/index.js': 'module.exports = 1;\n' });
    expect(await changes.install(batch.id, signal)).toMatchObject({ kind: 'failed' });
    expect(getBatch(h.store.db, batch.id).notices).toEqual([]);
  });

  it('refuses a task working in the builder’s own checkout', async () => {
    h = createDeliveryHarness({ workspaceMode: 'shared' }, { trigger: false });
    const started = h.starter.startTask(h.addTask('Alpha').id);
    await h.jobs.idle();
    const batch = getBatch(h.store.db, started.id);
    const changes = createDependencyChanges(h.ctx, createBaseUpdates(h.ctx));
    expect(await changes.install(batch.id, signal)).toMatchObject({ kind: 'refused' });
  });
});
