import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  migrateDatabase,
  openDatabase,
  PlaybookMoveMissingError,
  SchemaMismatchError,
  type TendbDatabase,
} from './index';
import { migrationsBefore } from './migrations-test-support';

const AT = '2026-11-14T12:00:00.000Z';
const DROP = '0087_drop_old_routing';

let dir: string;
let db: TendbDatabase;

beforeEach(() => {
  // A space in the path mirrors ~/Library/Application Support/10db.
  dir = mkdtempSync(join(tmpdir(), '10db pre-playbook routing '));
  db = openDatabase(join(dir, '10db.sqlite'));
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const sql = (text: string, ...values: unknown[]) => db.$client.prepare(text).run(...values);
const names = (text: string) =>
  z
    .array(z.object({ name: z.string() }))
    .parse(db.$client.prepare(text).all())
    .map((row) => row.name);
const tables = () => names("SELECT name FROM sqlite_master WHERE type = 'table'");
const appliedCount = () =>
  z
    .array(z.object({ n: z.number() }))
    .parse(db.$client.prepare('SELECT count(*) AS n FROM __drizzle_migrations').all())[0]?.n;

const PRE_PLAYBOOK_TABLES = ['flows', 'patterns', 'role_settings', 'team_bindings'];

const markMoved = () =>
  sql(`INSERT INTO app_settings (key, value, updated_at) VALUES ('playbook.moved', 'true', ?)`, AT);

const persona = (pin: string | null, score: number | null) =>
  sql(
    `INSERT INTO personas (id, key, name, role, tools, instructions, skills, model_pin, minimum_score,
       archived, created_at, updated_at)
     VALUES ('per_a', 'a', 'A', 'review', 'read_only', 'x', '[]', ?, ?, 0, ?, ?)`,
    pin,
    score,
    AT,
    AT,
  );

/** A project, with the flow it was given when `flowId` is set. */
function project(flowId: string | null = null): void {
  db.$client.pragma('foreign_keys = OFF');
  sql(
    `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
     VALUES ('acc_a', 'claude_subscription', 'a', 'me', '{}', 2, ?, ?)`,
    AT,
    AT,
  );
  sql(
    `INSERT INTO projects (id, name, repo_path, gate_command, areas, hazards, max_lanes, provider, account_id,
       handoff_pct, nudge_pct, human_wait_minutes, flow_id, created_at, updated_at)
     VALUES ('prj_a', 'a', '/tmp/a', 'true', '[]', '[]', 2, 'claude', 'acc_a', 40, 50, 10, ?, ?, ?)`,
    flowId,
    AT,
    AT,
  );
}

/** A project and a task, so a task column can hold a value the playbook replaced. */
function task(riskTags: string, flowId: string | null): void {
  project();
  sql(
    `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, areas, status, board_order,
       workspace_mode, risk_tags, flow_id, created_at, updated_at)
     VALUES ('tsk_a', 'prj_a', 't', '', '[]', '[]', 'ready', 1, 'shared', ?, ?, ?, ?)`,
    riskTags,
    flowId,
    AT,
    AT,
  );
}

/** What an unmoved database can hold, one row each: a table row or a value in a column the playbook replaced. */
const UNMOVED: readonly (readonly [name: string, seed: () => void])[] = [
  [
    'a role setting',
    () =>
      sql(
        `INSERT INTO role_settings (role, project_id, setting, updated_at) VALUES ('review', NULL, '{"kind":"top_of_tier"}', ?)`,
        AT,
      ),
  ],
  [
    'a flow',
    () =>
      sql(
        `INSERT INTO flows (id, name, steps, created_at, updated_at) VALUES ('flw_a', 'f', '[]', ?, ?)`,
        AT,
        AT,
      ),
  ],
  [
    'a pattern',
    () =>
      sql(
        `INSERT INTO patterns (id, project_id, name, match, setting, position, created_at, updated_at)
         VALUES ('pat_a', NULL, 'p', '{}', '{"kind":"top_of_tier"}', 0, ?, ?)`,
        AT,
        AT,
      ),
  ],
  [
    'a team binding',
    () => {
      project();
      persona(null, null);
      sql(
        `INSERT INTO team_bindings (project_id, role, persona_id) VALUES ('prj_a', 'review', 'per_a')`,
      );
    },
  ],
  [
    'a project’s flow',
    () => {
      project('flw_a');
    },
  ],
  ['a persona’s model pin', () => persona('{"model":"claude-opus-5-5","effort":"high"}', null)],
  ['a persona’s minimum score', () => persona(null, 50)],
  [
    'a task’s risk tags',
    () => {
      task('["security"]', null);
    },
  ],
  [
    'a task’s flow',
    () => {
      task('[]', 'flw_a');
    },
  ],
];

describe('the migration that drops the routing tables the playbook replaced', () => {
  it('migrates an empty file, a fresh install, with neither the setting nor any pre-playbook row', () => {
    migrateDatabase(db);
    expect(tables()).not.toEqual(expect.arrayContaining(['flows']));
  });

  it('migrates a database at the previous head whose pre-playbook tables are empty and the setting is absent', () => {
    migrateDatabase(db, migrationsBefore(dir, DROP));
    expect(tables()).toEqual(expect.arrayContaining(PRE_PLAYBOOK_TABLES));
    persona(null, null);
    task('[]', null);
    migrateDatabase(db);
    expect(tables().filter((name) => PRE_PLAYBOOK_TABLES.includes(name))).toEqual([]);
    expect(names('SELECT key AS name FROM personas')).toEqual(['a']);
  });

  it('migrates pre-playbook rows once the move has run, and keeps the rows the playbook replaced them with', () => {
    migrateDatabase(db, migrationsBefore(dir, DROP));
    markMoved();
    UNMOVED.forEach(([, seed], i) => {
      if (i < 2) seed();
    });
    persona('{"model":"claude-opus-5-5","effort":"high"}', 50);
    task('["security"]', 'flw_a');
    migrateDatabase(db);
    expect(tables().filter((name) => PRE_PLAYBOOK_TABLES.includes(name))).toEqual([]);
    expect(names('SELECT id AS name FROM tasks')).toEqual(['tsk_a']);
    expect(names("SELECT name FROM pragma_table_info('personas')")).not.toContain('model_pin');
  });

  it('reads a playbook.moved that is not JSON as not moved, and refuses', () => {
    migrateDatabase(db, migrationsBefore(dir, DROP));
    sql(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('playbook.moved', 'tru', ?)`,
      AT,
    );
    sql(
      `INSERT INTO flows (id, name, steps, created_at, updated_at) VALUES ('flw_a', 'f', '[]', ?, ?)`,
      AT,
      AT,
    );
    expect(() => {
      migrateDatabase(db);
    }).toThrow(PlaybookMoveMissingError);
  });

  it('refuses, and changes nothing, when any pre-playbook row is held and the move has not run', () => {
    migrateDatabase(db, migrationsBefore(dir, DROP));
    db.$client.close();
    const head = join(dir, '10db.sqlite');
    for (const [i, [name, seed]] of UNMOVED.entries()) {
      // Each row on a copy of its own of the database at the previous head.
      const file = join(dir, `row-${String(i)}.sqlite`);
      copyFileSync(head, file);
      db = openDatabase(file);
      seed();
      const before = appliedCount();
      let refused: unknown;
      try {
        migrateDatabase(db);
      } catch (error) {
        refused = error;
      }
      expect.soft(refused, name).toBeInstanceOf(PlaybookMoveMissingError);
      expect.soft(refused, name).toBeInstanceOf(SchemaMismatchError);
      expect
        .soft(refused instanceof Error ? refused.message : '', name)
        .toContain('Open a 10db build from #608 (f31017b6) through 81715524 once');
      expect.soft(appliedCount(), name).toBe(before);
      expect.soft(tables(), name).toEqual(expect.arrayContaining(PRE_PLAYBOOK_TABLES));
      db.$client.close();
    }
    db = openDatabase(head);
  });
});
