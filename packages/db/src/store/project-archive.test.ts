import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertInboxItem, listInbox } from './inbox';
import {
  archiveProject,
  getProject,
  listActiveProjects,
  listArchivedProjects,
  listProjects,
  restoreProject,
} from './projects';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

let store: Store;
const card = (projectId: ReturnType<typeof seedProject>['id']) =>
  store.write((ctx) =>
    insertInboxItem(ctx, {
      projectId,
      kind: 'flag',
      title: 'Look at this',
      body: '',
      options: [],
      recommendation: null,
      category: 'access',
      urgency: 'normal',
      detail: null,
      foldKey: null,
      targets: [],
    }),
  );

let close: () => void;

beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

describe('archiving a project', () => {
  it('hides it and its Inbox items, keeps its rows, and restore brings it back', () => {
    const keep = seedProject(store, { name: 'keep' });
    const gone = seedProject(store, { name: 'gone' });
    for (const project of [keep, gone]) card(project.id);
    expect(listInbox(store.db)).toHaveLength(2);

    store.write((ctx) => {
      archiveProject(ctx, gone.id);
    });
    expect(listActiveProjects(store.db).map((p) => p.id)).toEqual([keep.id]);
    // The guards that read every checkout still see it.
    expect(listProjects(store.db).map((p) => p.id)).toEqual([gone.id, keep.id]);
    expect(listArchivedProjects(store.db).map((p) => p.id)).toEqual([gone.id]);
    expect(getProject(store.db, gone.id).archivedAt).not.toBeNull();
    expect(listInbox(store.db).map((i) => i.projectId)).toEqual([keep.id]);
    expect(listInbox(store.db, { projectId: gone.id })).toHaveLength(1);

    store.write((ctx) => {
      restoreProject(ctx, gone.id);
    });
    expect(listActiveProjects(store.db).map((p) => p.id)).toEqual([gone.id, keep.id]);
    expect(listArchivedProjects(store.db)).toEqual([]);
    expect(listInbox(store.db)).toHaveLength(2);
  });
});
