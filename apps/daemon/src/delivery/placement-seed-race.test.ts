import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceMode, type BatchDto } from '@10db/contracts';
import { getBatch } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import type * as WorktreeSeedModule from './worktree-seed';

// Task placement spec §7: a shared batch that starts while a copy's seed clone is running can cut,
// open and launch a lane that writes `node_modules` while the clone is still reading it, so what the
// clone made is thrown away and the install builds `node_modules` instead.

type WorktreeSeed = typeof WorktreeSeedModule;

/** What runs once the real clone has finished, before the cut looks again. */
const during: { run: (() => void) | null } = { run: null };

vi.mock('./worktree-seed', async (importOriginal) => {
  const real = await importOriginal<WorktreeSeed>();
  return {
    ...real,
    seedWorktree: async (input: Parameters<WorktreeSeed['seedWorktree']>[0]) => {
      const result = await real.seedWorktree(input);
      during.run?.();
      return result;
    },
  };
});

let h: DeliveryHarness;
beforeEach(() => {
  h = createDeliveryHarness({}, { trigger: false });
});
afterEach(() => {
  during.run = null;
  h.close();
});

describe('a shared batch that starts during a copy seed clone', () => {
  it('leaves nothing the clone read in the copy, and installs instead', async () => {
    h.commit('.gitignore', 'node_modules/\n');
    h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    h.git$('push', '-q', 'origin', 'main');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(h.repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    const alpha = h.addTask('Alpha', { workspaceMode: WorkspaceMode.Shared });
    during.run = () => {
      during.run = null;
      h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: [alpha.id] });
    };
    const copied = h.addTask('Copied', { workspaceMode: WorkspaceMode.Worktree, areas: ['api'] });
    const [started] = h.starter.startBatch(h.project.id, { title: 'Copied', taskIds: [copied.id] });
    if (started === undefined) throw new Error('expected a batch');
    await h.jobs.idle();
    const batch: BatchDto = getBatch(h.store.db, started.id);
    expect(batch.state).toBe('OPEN');
    expect(existsSync(join(batch.worktreePath ?? '', 'node_modules/pkg/index.js'))).toBe(false);
    expect(
      h.pnpm
        .calls()
        .filter((call) => call.startsWith(`${realpathSync(batch.worktreePath ?? '')} |`)),
    ).toHaveLength(1);
  });
});
