import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchState, type BatchId, type ProjectId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from '../database';
import {
  createStore,
  getBatch,
  insertBatch,
  listWatchedPullRequests,
  patchBatch,
  recordPullRequestStatus,
  seedProject,
  transitionBatch,
  type PullRequestStatusInput,
  type Store,
} from './index';

let dir: string;
let dbPath: string;
let store: Store;
let closeDb: () => void;

function open(): void {
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  store = createStore(db);
  closeDb = () => db.$client.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '10db-pr-status-'));
  dbPath = join(dir, 'db.sqlite');
  open();
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const status = (over: Partial<PullRequestStatusInput> = {}): PullRequestStatusInput => ({
  state: 'open',
  checks: 'pending',
  failingChecks: [],
  checkedAt: '2026-10-29T12:00:00.000Z',
  unknownReason: null,
  ...over,
});

/** A worktree batch (so one project can hold several) taken to SHIPPED, with or without a pull request. */
function shipped(
  projectId: ProjectId,
  title: string,
  prUrl: string | null = `https://github.com/o/r/pull/${title}`,
) {
  const id = store.write((ctx) =>
    insertBatch(ctx, { projectId, title, baseBranch: 'main', worktreePath: `/tmp/wt/${title}` }),
  ).value.id;
  const to = (state: BatchState) => store.write((ctx) => transitionBatch(ctx, id, { to: state }));
  to(BatchState.Open);
  to(BatchState.Shipping);
  store.write((ctx) =>
    transitionBatch(ctx, id, {
      to: BatchState.Shipped,
      ...(prUrl ? { patch: { prUrl } } : {}),
    }),
  );
  return id;
}

describe('a shipped batch’s pull request status', () => {
  it('reads null until a status is recorded', () => {
    const project = seedProject(store, { delivery: 'pull_request' });
    const id = shipped(project.id, 'one');
    expect(getBatch(store.db, id).pr).toBeNull();
  });

  it('round-trips a status, failing checks included', () => {
    const project = seedProject(store, { delivery: 'pull_request' });
    const id = shipped(project.id, 'one');
    const s = status({
      checks: 'failing',
      failingChecks: [
        { name: 'build', url: 'https://github.com/o/r/runs/1' },
        { name: 'lint', url: null },
      ],
    });
    const { value } = store.write((ctx) => recordPullRequestStatus(ctx, id, s));
    expect(value.pr).toEqual(s);
    expect(getBatch(store.db, id).pr).toEqual(s);
  });

  it('records an unknown state with its reason, then replaces it', () => {
    const project = seedProject(store, { delivery: 'pull_request' });
    const id = shipped(project.id, 'one');
    const unknown = status({
      state: 'unknown',
      checks: 'unknown',
      unknownReason: 'gh is signed out',
    });
    store.write((ctx) => recordPullRequestStatus(ctx, id, unknown));
    expect(getBatch(store.db, id).pr).toEqual(unknown);
    store.write((ctx) => recordPullRequestStatus(ctx, id, status({ checks: 'passing' })));
    expect(getBatch(store.db, id).pr).toEqual(status({ checks: 'passing' }));
  });

  it('emits batch.updated naming the pr', () => {
    const project = seedProject(store, { delivery: 'pull_request' });
    const id = shipped(project.id, 'one');
    const { events } = store.write((ctx) => recordPullRequestStatus(ctx, id, status()));
    expect(events.map((e) => [e.type, e.entityType, e.entityId, e.data])).toEqual([
      ['batch.updated', 'batch', id, { changed: ['pr'] }],
    ]);
  });

  it('keeps the status in a reopened database', () => {
    const project = seedProject(store, { delivery: 'pull_request' });
    const id = shipped(project.id, 'one');
    const s = status({ state: 'closed', checks: 'passing' });
    store.write((ctx) => recordPullRequestStatus(ctx, id, s));
    closeDb();
    open();
    expect(getBatch(store.db, id).pr).toEqual(s);
  });
});

describe('listWatchedPullRequests', () => {
  it('lists shipped batches with a pull request whose state is unread, open or unknown, oldest first', () => {
    const project = seedProject(store, { delivery: 'pull_request' });
    const fresh = shipped(project.id, 'fresh');
    const open1 = shipped(project.id, 'open');
    const unknown = shipped(project.id, 'unknown');
    const merged = shipped(project.id, 'merged');
    const closed = shipped(project.id, 'closed');
    shipped(project.id, 'noprurl', null);
    store.write((ctx) => recordPullRequestStatus(ctx, open1, status()));
    store.write((ctx) =>
      recordPullRequestStatus(
        ctx,
        unknown,
        status({ state: 'unknown', checks: 'unknown', unknownReason: 'x' }),
      ),
    );
    store.write((ctx) => recordPullRequestStatus(ctx, merged, status({ state: 'merged' })));
    store.write((ctx) => recordPullRequestStatus(ctx, closed, status({ state: 'closed' })));

    expect(listWatchedPullRequests(store.db).map((b) => b.id)).toEqual([fresh, open1, unknown]);
  });

  it('leaves out batches that are not shipped, even with a pull request url', () => {
    const project = seedProject(store, { delivery: 'pull_request' });
    const id: BatchId = store.write((ctx) =>
      insertBatch(ctx, { projectId: project.id, title: 'open', baseBranch: 'main' }),
    ).value.id;
    store.write((ctx) => patchBatch(ctx, id, { prUrl: 'https://github.com/o/r/pull/9' }));
    expect(listWatchedPullRequests(store.db)).toEqual([]);
  });
});
