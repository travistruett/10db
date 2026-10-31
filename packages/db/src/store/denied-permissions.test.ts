import { mintId, type WorkstreamId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deniedPermissionsForWorkstream, insertInboxItem, updateInboxItem } from './inbox';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

function permissionCard(
  projectId: ReturnType<typeof seedProject>['id'],
  workstreamId: WorkstreamId,
  summary: string,
  toolName = 'Bash',
) {
  return store.write((ctx) =>
    insertInboxItem(ctx, {
      projectId,
      kind: 'permission',
      title: `Allow ${toolName}?`,
      body: summary,
      options: [],
      recommendation: null,
      category: 'environment',
      urgency: 'normal',
      detail: { toolName, summary },
      foldKey: null,
      targets: [{ workstreamId, sessionId: null }],
    }),
  ).value;
}

function answer(id: ReturnType<typeof permissionCard>['id'], choice: string, note?: string) {
  store.write((ctx) =>
    updateInboxItem(ctx, id, {
      state: 'RESOLVED',
      answer: note === undefined ? { choice } : { choice, note },
    }),
  );
}

describe('deniedPermissionsForWorkstream', () => {
  it('lists the calls the builder denied for the workstream, oldest first, with their notes', () => {
    const project = seedProject(store);
    const ws = mintId('Workstream');
    const first = permissionCard(project.id, ws, 'yes > /dev/null &');
    const second = permissionCard(project.id, ws, 'curl https://example.com', 'WebFetch');
    answer(first.id, 'deny', 'no CPU load');
    answer(second.id, 'deny');
    expect(deniedPermissionsForWorkstream(store.db, ws)).toEqual([
      { toolName: 'Bash', summary: 'yes > /dev/null &', note: 'no CPU load' },
      { toolName: 'WebFetch', summary: 'curl https://example.com', note: null },
    ]);
  });

  it('leaves out allowed calls, cards still open and cancelled ones', () => {
    const project = seedProject(store);
    const ws = mintId('Workstream');
    answer(permissionCard(project.id, ws, 'pnpm add zod').id, 'allow_once');
    permissionCard(project.id, ws, 'still open');
    const cancelled = permissionCard(project.id, ws, 'cancelled');
    store.write((ctx) => updateInboxItem(ctx, cancelled.id, { state: 'CANCELLED' }));
    expect(deniedPermissionsForWorkstream(store.db, ws)).toEqual([]);
  });

  it('leaves out another workstream, and any card that is not a permission', () => {
    const project = seedProject(store);
    const ws = mintId('Workstream');
    answer(permissionCard(project.id, mintId('Workstream'), 'other lane').id, 'deny');
    const question = store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: project.id,
        kind: 'question',
        title: 'Which?',
        body: '',
        options: [],
        recommendation: null,
        category: 'design',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [{ workstreamId: ws, sessionId: null }],
      }),
    ).value;
    answer(question.id, 'deny');
    expect(deniedPermissionsForWorkstream(store.db, ws)).toEqual([]);
  });

  it('keeps the newest when there are more than the limit', () => {
    const project = seedProject(store);
    const ws = mintId('Workstream');
    for (const name of ['a', 'b', 'c']) answer(permissionCard(project.id, ws, name).id, 'deny');
    expect(deniedPermissionsForWorkstream(store.db, ws, 2).map((d) => d.summary)).toEqual([
      'b',
      'c',
    ]);
  });
});
