import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mintId,
  type InboxItemId,
  type ProjectId,
  type WorkstreamId,
  type WorkstreamState,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_MIGRATIONS_DIR, migrateDatabase, openDatabase, type TendbDatabase } from '../database';
import { lastConfigHead, lastListed, markListed, unlistedEndedRuns } from './skip-listings';
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

const mark = (
  id: WorkstreamId,
  through: ReturnType<typeof skip> | null,
  inbox: InboxItemId | null,
  configHead: string | null = null,
) =>
  store.write((ctx) => {
    markListed(ctx, id, through, inbox, configHead);
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

  it('the config head is the newest a listing read, past one that read none', () => {
    const run = runOf(store, seedProject(store).id, 'DONE');
    expect(lastConfigHead(store.db, run)).toBeNull();
    mark(run, null, null, 'aaa1');
    mark(run, null, null, 'bbb2');
    mark(run, null, null, null);
    expect(lastConfigHead(store.db, run)).toBe('bbb2');
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

/**
 * A task and its run at `state`, written in SQL with only the columns a database at the backfill has, so a
 * column added by a later migration doesn't break the seed.
 */
function rawRunOf(db: TendbDatabase, projectId: ProjectId, state: WorkstreamState): WorkstreamId {
  const at = new Date().toISOString();
  const taskId = mintId('Task');
  const id = mintId('Workstream');
  db.$client
    .prepare(
      `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, areas, status, board_order,
         workspace_mode, created_at, updated_at)
       VALUES (?, ?, 'Alpha', '', '["x"]', '["api"]', 'open', ?, 'shared', ?, ?)`,
    )
    .run(taskId, projectId, Date.now(), at, at);
  db.$client
    .prepare(
      `INSERT INTO workstreams (id, task_id, project_id, state, next_action, attempt, recovery_attempts, model,
         effort, fence, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{"kind":"start"}', 0, 0, 'claude-sonnet-5-5', 'medium', 0, ?, ?)`,
    )
    .run(id, taskId, projectId, state, at, at);
  return id;
}

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
    const end = journal.entries.findIndex((e) => e.tag === '0082_skip_listings');
    for (const later of journal.entries.splice(end + 1)) rmSync(join(older, `${later.tag}.sql`));
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    const db = openDatabase(join(dir, '10db.sqlite'));
    try {
      migrateDatabase(db, older);
      const old = createStore(db);
      const project = seedProject(old).id;
      rawRunOf(db, project, 'DONE');
      rawRunOf(db, project, 'FAILED');
      const running = rawRunOf(db, project, 'RUNNING');
      migrateDatabase(db);
      expect(unlistedEndedRuns(db)).toEqual([]);
      db.$client.prepare("UPDATE workstreams SET state = 'DONE' WHERE id = ?").run(running);
      expect(unlistedEndedRuns(db)).toEqual([running]);
    } finally {
      db.$client.close();
    }
  });
});
