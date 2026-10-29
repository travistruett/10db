import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DB_MIGRATIONS_DIR,
  MigrationIntegrityError,
  migrateDatabase,
  openDatabase,
  schema,
  type TendbDatabase,
} from './index';

let dir: string;
let db: TendbDatabase;

beforeEach(() => {
  // A space in the path mirrors ~/Library/Application Support/10db.
  dir = mkdtempSync(join(tmpdir(), '10db db test '));
  db = openDatabase(join(dir, '10db.sqlite'));
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('uses WAL and enforces foreign keys', () => {
    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('loads the native addon from an explicit path when one is given', () => {
    const missing = join(dir, 'no-such-addon.node');
    expect(() => openDatabase(join(dir, 'other.sqlite'), { nativeBinding: missing })).toThrow(
      /no-such-addon/,
    );
  });

  it('has FTS5 compiled in', () => {
    const row = db.$client
      .prepare("SELECT 1 AS ok FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'")
      .get();
    expect(row).toEqual({ ok: 1 });
  });
});

describe('migrateDatabase', () => {
  it('creates app_settings and round-trips a JSON value', () => {
    migrateDatabase(db);
    db.insert(schema.appSettings)
      .values({
        key: 'keepAwake',
        value: { mode: 'while-running' },
        updatedAt: '2026-10-13T12:00:00.000Z',
      })
      .run();
    const row = db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, 'keepAwake'))
      .get();
    expect(row?.value).toEqual({ mode: 'while-running' });
  });

  it('is idempotent', () => {
    migrateDatabase(db);
    expect(() => {
      migrateDatabase(db);
    }).not.toThrow();
  });

  it.each([
    [
      'an applied migration the baseline no longer has',
      "UPDATE __drizzle_migrations SET hash = 'f00d' WHERE rowid = 1",
      'StaleSchemaBaselineError',
    ],
    [
      'more applied migrations than this build has, after a matching prefix',
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('f00d', 1)",
      'NewerSchemaError',
    ],
  ])('refuses a database whose migrations disagree: %s', (_name, tamper, expected) => {
    migrateDatabase(db);
    db.$client.exec(tamper);
    let refusal: unknown;
    try {
      migrateDatabase(db);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toMatchObject({ name: expected });
    expect(String(refusal)).toContain(join(dir, '10db.sqlite'));
  });
});

describe('a migration that leaves a dangling reference', () => {
  it('is refused with a typed error', () => {
    const custom = join(dir, 'dangling');
    mkdirSync(join(custom, 'meta'), { recursive: true });
    writeFileSync(
      join(custom, 'meta/_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [{ idx: 0, version: '6', when: 1, tag: '0000_dangling', breakpoints: true }],
      }),
    );
    writeFileSync(
      join(custom, '0000_dangling.sql'),
      [
        'CREATE TABLE parent (id integer PRIMARY KEY);',
        'CREATE TABLE child (id integer PRIMARY KEY, parent_id integer REFERENCES parent(id));',
        'INSERT INTO child (id, parent_id) VALUES (1, 99);',
      ].join('\n--> statement-breakpoint\n'),
    );
    expect(() => {
      migrateDatabase(db, custom);
    }).toThrow(MigrationIntegrityError);
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('migrating a v0.1.0 database', () => {
  const AT = '2026-10-21T12:00:00.000Z';
  const projectA = 'prj_a';
  const projectB = 'prj_b';

  /** The migrations v0.1.0 shipped: the first two journal entries and their SQL. */
  function releasedMigrations(): string {
    const released = join(dir, 'released');
    cpSync(DB_MIGRATIONS_DIR, released, { recursive: true });
    const journalPath = join(released, 'meta/_journal.json');
    // A journal this test just copied from the shipped migrations; the shape is known.
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    const keep = new Set(journal.entries.slice(0, 2).map((e) => e.tag));
    journal.entries = journal.entries.filter((e) => keep.has(e.tag));
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    for (const file of readdirSync(released)) {
      if (file.endsWith('.sql') && !keep.has(file.slice(0, -'.sql'.length)))
        rmSync(join(released, file));
    }
    return released;
  }

  beforeEach(() => {
    migrateDatabase(db, releasedMigrations());
    // The rows below stand alone: only the columns under test matter.
    db.$client.pragma('foreign_keys = OFF');
    db.$client
      .prepare(
        `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
         VALUES ('acc_x', 'subscription', 'main', 'me', '{}', 2, ?, ?)`,
      )
      .run(AT, AT);
    const project = db.$client.prepare(
      `INSERT INTO projects (id, name, repo_path, gate_command, areas, hazards, max_lanes, provider, account_id,
         model, effort, handoff_pct, nudge_pct, human_wait_minutes, created_at, updated_at)
       VALUES (?, ?, ?, 'true', '[]', '[]', 2, 'claude', 'acc_x', 'sonnet', 'medium', 40, 50, 10, ?, ?)`,
    );
    project.run(projectA, 'a', '/tmp/a', AT, AT);
    project.run(projectB, 'b', '/tmp/b', AT, AT);
    for (const [suffix, projectId] of [
      ['a', projectA],
      ['b', projectB],
    ] as const) {
      db.$client
        .prepare(
          `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, areas, status,
             board_order, workspace_mode, created_at, updated_at)
           VALUES (?, ?, 't', '', '[]', '[]', 'ready', 1, 'shared', ?, ?)`,
        )
        .run(`tsk_${suffix}`, projectId, AT, AT);
      db.$client
        .prepare(
          `INSERT INTO workstreams (id, task_id, project_id, state, next_action, attempt, recovery_attempts,
             model, effort, fence, created_at, updated_at)
           VALUES (?, ?, ?, 'RUNNING', 'none', 1, 0, 'sonnet', 'medium', 1, ?, ?)`,
        )
        .run(`wst_${suffix}`, `tsk_${suffix}`, projectId, AT, AT);
    }
    const claim = db.$client.prepare(
      `INSERT INTO claims (id, project_id, workstream_id, kind, name, exclusive, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'hazard', 'docker', 1, ?, ?, ?)`,
    );
    claim.run('clm_a', projectA, 'wst_a', AT, AT, AT);
    claim.run('clm_b', projectB, 'wst_b', AT, AT, AT);
    db.$client
      .prepare(
        `INSERT INTO batches (id, project_id, title, state, base_branch, created_at, updated_at)
         VALUES ('bat_old', ?, 'old', 'OPEN', 'main', ?, ?)`,
      )
      .run(projectA, AT, AT);
    migrateDatabase(db);
    db.$client.pragma('foreign_keys = ON');
  });

  it("every claim's scope is its project", () => {
    const rows = db.$client.prepare('SELECT project_id, scope FROM claims').all() as {
      project_id: string;
      scope: string;
    }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.scope).toBe(row.project_id);
  });

  it("two projects' active claims on the same hazard both survive", () => {
    const rows = db.$client
      .prepare("SELECT id FROM claims WHERE name = 'docker' AND released_at IS NULL ORDER BY id")
      .all();
    expect(rows).toEqual([{ id: 'clm_a' }, { id: 'clm_b' }]);
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO claims (id, project_id, workstream_id, kind, name, exclusive, lease_expires_at, scope, created_at, updated_at)
           VALUES ('clm_c', ?, 'wst_c', 'hazard', 'docker', 1, ?, ?, ?, ?)`,
        )
        .run(projectA, AT, projectA, AT, AT),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('projects default to shared mode with node_modules seeded', () => {
    const rows = db.$client.prepare('SELECT workspace_mode, worktree_seed FROM projects').all() as {
      workspace_mode: string;
      worktree_seed: string;
    }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.workspace_mode).toBe('shared');
      expect(JSON.parse(row.worktree_seed)).toEqual(['node_modules']);
    }
  });

  it('the old unfinished batch reads as shared, with no worktree path', () => {
    const row = db.$client.prepare("SELECT worktree_path FROM batches WHERE id = 'bat_old'").get();
    expect(row).toEqual({ worktree_path: null });
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO batches (id, project_id, title, state, base_branch, created_at, updated_at)
           VALUES ('bat_new', ?, 'new', 'CUTTING', 'main', ?, ?)`,
        )
        .run(projectA, AT, AT),
    ).toThrow(/UNIQUE constraint failed: batches\.project_id/);
  });
});

describe('migrating a database that has a gate command and evidence', () => {
  const AT = '2026-10-21T12:00:00.000Z';

  /** Every migration but the last, so the one under test runs over rows a real database holds. */
  function allButLast(): string {
    const older = join(dir, 'older');
    cpSync(DB_MIGRATIONS_DIR, older, { recursive: true });
    const journalPath = join(older, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    const last = journal.entries.pop();
    if (last === undefined) throw new Error('no migrations');
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    rmSync(join(older, `${last.tag}.sql`));
    return older;
  }

  it('keeps the rows that point at a project and an evidence row', () => {
    migrateDatabase(db, allButLast());
    const run = (sql: string, ...args: string[]): void => {
      db.$client.prepare(sql).run(...args);
    };
    run(
      `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
       VALUES ('acc_x', 'subscription', 'main', 'me', '{}', 2, ?, ?)`,
      AT,
      AT,
    );
    run(
      `INSERT INTO projects (id, name, repo_path, gate_command, areas, hazards, max_lanes, provider, account_id,
         handoff_pct, nudge_pct, human_wait_minutes, created_at, updated_at)
       VALUES ('prj_a', 'a', '/tmp/a', 'make gate', '[]', '[]', 2, 'claude', 'acc_x', 40, 50, 10, ?, ?)`,
      AT,
      AT,
    );
    run(
      `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, areas, status, board_order,
         workspace_mode, created_at, updated_at)
       VALUES ('tsk_a', 'prj_a', 't', '', '[]', '[]', 'queued', 1, 'shared', ?, ?)`,
      AT,
      AT,
    );
    run(
      `INSERT INTO workstreams (id, task_id, project_id, state, next_action, attempt, recovery_attempts, model,
         effort, fence, created_at, updated_at)
       VALUES ('wst_a', 'tsk_a', 'prj_a', 'QUEUED', '{"kind":"start"}', 0, 0, 'sonnet', 'medium', 0, ?, ?)`,
      AT,
      AT,
    );
    run(
      `INSERT INTO evidence (id, workstream_id, kind, command, exit_code, summary, commit_shas, created_at)
       VALUES ('evd_a', 'wst_a', 'gate', 'make gate', 0, 'ok', '[]', ?)`,
      AT,
    );
    migrateDatabase(db);
    expect(db.$client.prepare('SELECT gate_command FROM projects').all()).toEqual([
      { gate_command: 'make gate' },
    ]);
    expect(db.$client.prepare('SELECT project_id FROM tasks').all()).toEqual([
      { project_id: 'prj_a' },
    ]);
    expect(db.$client.prepare('SELECT command, exit_code FROM evidence').all()).toEqual([
      { command: 'make gate', exit_code: 0 },
    ]);
    db.$client.prepare('UPDATE projects SET gate_command = NULL').run();
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });
});
