import { join } from 'node:path';
import type { ProjectId } from '@10db/contracts';
import { clearWorktreePath, createTestStore, insertBatch, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allCheckouts, batchCheckout, checkoutOf, projectAtCheckout } from './checkout';

let store: Store;
let close: () => void;

beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

function batchOf(projectId: ProjectId, worktreePath?: string) {
  return store.write((ctx) =>
    insertBatch(ctx, {
      projectId,
      title: 'Greetings',
      baseBranch: 'main',
      ...(worktreePath === undefined ? {} : { worktreePath }),
    }),
  ).value;
}

describe('checkoutOf', () => {
  it('no batch: the project checkout', () => {
    const project = seedProject(store, { repoPath: '/repos/a' });
    expect(checkoutOf(store.db, { projectId: project.id, batchId: null })).toBe('/repos/a');
  });

  it('a shared batch: the project checkout', () => {
    const project = seedProject(store, { repoPath: '/repos/a' });
    const batch = batchOf(project.id);
    expect(checkoutOf(store.db, { projectId: project.id, batchId: batch.id })).toBe('/repos/a');
    expect(batchCheckout(store.db, batch)).toBe('/repos/a');
  });

  it('a worktree batch: its worktree', () => {
    const project = seedProject(store, { repoPath: '/repos/a' });
    const batch = batchOf(project.id, '/wt/one');
    expect(checkoutOf(store.db, { projectId: project.id, batchId: batch.id })).toBe('/wt/one');
    expect(batchCheckout(store.db, batch)).toBe('/wt/one');
  });

  it('a worktree batch after removal: the project checkout', () => {
    const project = seedProject(store, { repoPath: '/repos/a' });
    const batch = batchOf(project.id, '/wt/one');
    const cleared = store.write((ctx) => clearWorktreePath(ctx, batch.id)).value;
    expect(checkoutOf(store.db, { projectId: project.id, batchId: batch.id })).toBe('/repos/a');
    expect(batchCheckout(store.db, cleared)).toBe('/repos/a');
  });
});

describe('allCheckouts', () => {
  it('lists every project and every live worktree, not a cleared one', () => {
    const a = seedProject(store, { repoPath: '/repos/a' });
    const b = seedProject(store, { repoPath: '/repos/b' });
    batchOf(a.id, '/wt/one');
    const gone = batchOf(b.id, '/wt/two');
    store.write((ctx) => clearWorktreePath(ctx, gone.id));
    expect(allCheckouts(store.db).sort()).toEqual(['/repos/a', '/repos/b', '/wt/one']);
  });
});

describe('projectAtCheckout', () => {
  it('changes only repoPath', () => {
    const project = { id: 'p', repoPath: '/repos/a', name: 'x' };
    expect(projectAtCheckout(project, join('/wt', 'one'))).toEqual({
      id: 'p',
      repoPath: '/wt/one',
      name: 'x',
    });
    expect(projectAtCheckout(project, '/repos/a')).toBe(project);
  });
});
