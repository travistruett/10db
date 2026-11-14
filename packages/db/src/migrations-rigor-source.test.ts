import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrateDatabase, openDatabase, type TendbDatabase } from './index';
import { migrationsBefore } from './migrations-test-support';

const AT = '2026-11-13T12:00:00.000Z';
const MIGRATION = '0074_rigor_source_of_set_rigors';

let dir: string;
let db: TendbDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '10db rigor source '));
  db = openDatabase(join(dir, '10db.sqlite'));
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

it('reads a rigor stored before sources as the builder’s, and leaves a task with none', () => {
  migrateDatabase(db, migrationsBefore(dir, MIGRATION));
  db.$client.pragma('foreign_keys = OFF');
  db.$client
    .prepare(
      `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
       VALUES ('acc_x', 'gateway', 'gw', 'me', '{}', 2, ?, ?)`,
    )
    .run(AT, AT);
  db.$client
    .prepare(
      `INSERT INTO projects (id, name, repo_path, gate_command, areas, hazards, max_lanes, provider, account_id,
         handoff_pct, nudge_pct, human_wait_minutes, created_at, updated_at)
       VALUES ('prj_a', 'a', '/tmp/a', 'true', '[]', '[]', 2, 'claude', 'acc_x', 40, 50, 10, ?, ?)`,
    )
    .run(AT, AT);
  for (const [id, rigor] of [
    ['tsk_set', 'careful'],
    ['tsk_none', null],
  ] as const)
    db.$client
      .prepare(
        `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, areas, status,
           board_order, workspace_mode, rigor, created_at, updated_at)
         VALUES (?, 'prj_a', 't', '', '[]', '[]', 'ready', 1, 'shared', ?, ?, ?)`,
      )
      .run(id, rigor, AT, AT);

  migrateDatabase(db);

  const rows = db.$client
    .prepare(
      'SELECT id, rigor, rigor_source, rigor_reason, kinds_off, sized_for, sizing_calls FROM tasks ORDER BY id',
    )
    .all();
  expect(rows).toEqual([
    {
      id: 'tsk_none',
      rigor: null,
      rigor_source: null,
      rigor_reason: null,
      kinds_off: '[]',
      sized_for: null,
      sizing_calls: '{"rigor":null,"kinds":{}}',
    },
    {
      id: 'tsk_set',
      rigor: 'careful',
      rigor_source: 'builder',
      rigor_reason: null,
      kinds_off: '[]',
      sized_for: null,
      sizing_calls: '{"rigor":null,"kinds":{}}',
    },
  ]);
});
