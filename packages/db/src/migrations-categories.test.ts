import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrateDatabase, openDatabase, type TendbDatabase } from './index';
import { migrationsBefore } from './migrations-test-support';

const AT = '2026-11-12T12:00:00.000Z';
const MIGRATION = '0065_question_category_access';

let dir: string;
let db: TendbDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '10db categories '));
  db = openDatabase(join(dir, '10db.sqlite'));
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (text: string, ...values: unknown[]) => db.$client.prepare(text).run(...values);
const categories = (table: string): string[] =>
  db.$client
    .prepare(`SELECT category FROM ${table} ORDER BY id`)
    .all()
    .map((row) => String((row as { category: unknown }).category));

it('carries a stored environment card and route over to access, and leaves the rest', () => {
  migrateDatabase(db, migrationsBefore(dir, MIGRATION));
  db.$client.pragma('foreign_keys = OFF');
  run(
    `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
     VALUES ('acc_x', 'gateway', 'gw', 'me', '{}', 2, ?, ?)`,
    AT,
    AT,
  );
  run(
    `INSERT INTO projects (id, name, repo_path, gate_command, areas, hazards, max_lanes, provider, account_id,
       handoff_pct, nudge_pct, human_wait_minutes, created_at, updated_at)
     VALUES ('prj_a', 'a', '/tmp/a', 'true', '[]', '[]', 2, 'claude', 'acc_x', 40, 50, 10, ?, ?)`,
    AT,
    AT,
  );
  for (const [id, category] of [
    ['inb_1', 'environment'],
    ['inb_2', 'product'],
    ['inb_3', 'other'],
  ] as const)
    run(
      `INSERT INTO inbox_items (id, project_id, kind, state, title, body, options, category, urgency,
         assignee, targets, created_at, updated_at)
       VALUES (?, 'prj_a', 'question', 'OPEN', 't', 'b', '[]', ?, 'normal', 'me', '[]', ?, ?)`,
      id,
      category,
      AT,
      AT,
    );
  run(
    `INSERT INTO people (id, handle, name, is_builder, created_at, updated_at)
     VALUES ('psn_a', 'mark', 'Mark', 0, ?, ?)`,
    AT,
    AT,
  );
  for (const [id, category] of [
    ['rtr_1', 'environment'],
    ['rtr_2', 'design'],
  ] as const)
    run(
      `INSERT INTO routing_rules (id, project_id, category, person_id, created_at, updated_at)
       VALUES (?, 'prj_a', ?, 'psn_a', ?, ?)`,
      id,
      category,
      AT,
      AT,
    );

  migrateDatabase(db);

  expect(categories('inbox_items')).toEqual(['access', 'product', 'other']);
  expect(categories('routing_rules')).toEqual(['access', 'design']);
});
