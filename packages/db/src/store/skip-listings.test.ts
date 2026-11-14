import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxItemId, ProjectId, WorkstreamId, WorkstreamState } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_MIGRATIONS_DIR, migrateDatabase, openDatabase } from '../database';
import { lastListed, markListed, unlistedEndedRuns } from './skip-listings';
import { recordSkip } from './skipped-actions';
import { createStore, type Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

// T4 Task 9: each ended unattended run is checked for its Skipped while you were away item once per
// ending, and a run a crash left unchecked, or with skips after its last item, is found again.

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

function runOf(s: Store, projectId: ProjectId, state?: WorkstreamState): WorkstreamId {
  const task = s.write((ctx) =>
    insertTask(ctx, projectId, {
      title: 'Alpha',
      description: '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    }),
  ).value;
  const id = s.write((ctx) =>
    insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  ).value.id;
  if (state !== undefined)
    s.db.$client.prepare('UPDATE workstreams SET state = ? WHERE id = ?').run(state, id);
  return id;
}

const skip = (id: WorkstreamId, toolUseId: string) =>
  store.write((ctx) =>
    recordSkip(ctx, {
      workstreamId: id,
      sessionId: null,
      toolName: 'Bash',
      toolUseId,
      callKey: null,
      summary: 'curl x',
      kind: 'default_mode_card',
      limit: null,
      reason: 'r',
      source: 'broker',
    }),
  ).value;

const mark = (id: WorkstreamId, through: ReturnType<typeof skip>, inbox: InboxItemId | null) =>
  store.write((ctx) => {
    markListed(ctx, id, through, inbox);
  });

describe('skip listings', () => {
  it('the newest listing is the last', () => {
    const run = runOf(store, seedProject(store).id, 'DONE');
    expect(lastListed(store.db, run)).toBeUndefined();
    const first = skip(run, 'tu-1');
    mark(run, first, null);
    const second = skip(run, 'tu-2');
    mark(run, second, null);
    expect(lastListed(store.db, run)).toBe(second);
  });

  it('an ended run with skips after its listing is unlisted', () => {
    const run = runOf(store, seedProject(store).id, 'FAILED');
    mark(run, skip(run, 'tu-1'), null);
    expect(unlistedEndedRuns(store.db)).toEqual([]);
    skip(run, 'tu-2');
    expect(unlistedEndedRuns(store.db)).toEqual([run]);
  });

  it('an ended run with no listing row is unlisted, and one still running is not', () => {
    const project = seedProject(store).id;
    const done = runOf(store, project, 'DONE');
    runOf(store, project, 'RUNNING');
    runOf(store, project, 'CANCELLED');
    expect(unlistedEndedRuns(store.db)).toEqual([done]);
  });

  it('a run checked with nothing to say is not unlisted', () => {
    const run = runOf(store, seedProject(store).id, 'DONE');
    mark(run, null, null);
    expect(unlistedEndedRuns(store.db)).toEqual([]);
  });
});

describe('the listings backfill', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks every run that ended before it', () => {
    dir = mkdtempSync(join(tmpdir(), '10db skip listings '));
    const older = join(dir, 'migrations');
    cpSync(DB_MIGRATIONS_DIR, older, { recursive: true });
    const journalPath = join(older, 'meta/_journal.json');
    // The journal this test just copied from the shipped migrations; the shape is known.
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    const end = journal.entries.findIndex((e) => e.tag === '0076_skip_listings');
    for (const later of journal.entries.splice(end + 1)) rmSync(join(older, `${later.tag}.sql`));
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    const db = openDatabase(join(dir, '10db.sqlite'));
    try {
      migrateDatabase(db, older);
      const old = createStore(db);
      const project = seedProject(old).id;
      runOf(old, project, 'DONE');
      runOf(old, project, 'FAILED');
      const running = runOf(old, project, 'RUNNING');
      migrateDatabase(db);
      expect(unlistedEndedRuns(db)).toEqual([]);
      db.$client.prepare("UPDATE workstreams SET state = 'DONE' WHERE id = ?").run(running);
      expect(unlistedEndedRuns(db)).toEqual([running]);
    } finally {
      db.$client.close();
    }
  });
});
