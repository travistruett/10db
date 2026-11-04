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

/** The shipped migrations up to and including `lastTag`, so a later one runs over rows written before it. */
function migrationsThrough(lastTag: string): string {
  const older = join(dir, `through-${lastTag}`);
  cpSync(DB_MIGRATIONS_DIR, older, { recursive: true });
  const journalPath = join(older, 'meta/_journal.json');
  // A journal this test just copied from the shipped migrations; the shape is known.
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const end = journal.entries.findIndex((e) => e.tag === lastTag);
  if (end === -1) throw new Error(`no migration ${lastTag}`);
  for (const later of journal.entries.splice(end + 1)) rmSync(join(older, `${later.tag}.sql`));
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return older;
}

describe('migrating a database that holds Review cards', () => {
  const AT = '2026-10-21T12:00:00.000Z';

  beforeEach(() => {
    // The last migration before passing the gate stopped raising a Review card.
    migrateDatabase(db, migrationsThrough('0013_short_roughhouse'));
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
    const card = db.$client.prepare(
      `INSERT INTO inbox_items (id, project_id, kind, state, title, body, options, category, urgency, assignee,
         answer, targets, created_at, updated_at)
       VALUES (?, 'prj_a', ?, ?, ?, '', ?, 'product', 'low', 'me', ?, '[]', ?, ?)`,
    );
    const accept = JSON.stringify([{ label: 'accept', description: 'Looks good' }]);
    card.run('inb_review_open', 'review', 'OPEN', 'Review: t', accept, null, AT, AT);
    card.run(
      'inb_review_answered',
      'review',
      'RESOLVED',
      'Review: u',
      accept,
      JSON.stringify({ choice: 'accept' }),
      AT,
      AT,
    );
    card.run(
      'inb_question_open',
      'question',
      'OPEN',
      'Which?',
      JSON.stringify([{ label: 'a', description: '' }]),
      null,
      AT,
      AT,
    );
    migrateDatabase(db);
  });

  function card(id: string): { state: string; updated_at: string } {
    return db.$client.prepare('SELECT state, updated_at FROM inbox_items WHERE id = ?').get(id) as {
      state: string;
      updated_at: string;
    };
  }

  it('withdraws an open Review card, whose only answer just closed it', () => {
    const row = card('inb_review_open');
    expect(row.state).toBe('CANCELLED');
    expect(row.updated_at > AT).toBe(true);
    expect(row.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('leaves an answered Review card and every other open card as they were', () => {
    expect(card('inb_review_answered')).toEqual({ state: 'RESOLVED', updated_at: AT });
    expect(card('inb_question_open')).toEqual({ state: 'OPEN', updated_at: AT });
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

describe('migrating to task headlines', () => {
  it('gives a task made before it an empty headline and why, and keeps its title', () => {
    const AT = '2026-11-02T12:00:00.000Z';
    // The last migration before tasks had a headline and a why.
    migrateDatabase(db, migrationsThrough('0024_goal_visit_started_at'));
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
       VALUES ('tsk_a', 'prj_a', 'The promise', '', '[]', '[]', 'open', 1, 'shared', ?, ?)`,
      AT,
      AT,
    );
    migrateDatabase(db);
    expect(db.$client.prepare('SELECT title, headline, why FROM tasks').all()).toEqual([
      { title: 'The promise', headline: '', why: '' },
    ]);
  });
});

describe('migrating to per-task placement', () => {
  const AT = '2026-10-29T12:00:00.000Z';

  beforeEach(() => {
    // The last migration before placement moved onto the task.
    migrateDatabase(db, migrationsThrough('0014_withdraw_review_cards'));
    const run = (sql: string, ...args: string[]): void => {
      db.$client.prepare(sql).run(...args);
    };
    run(
      `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
       VALUES ('acc_x', 'subscription', 'main', 'me', '{}', 2, ?, ?)`,
      AT,
      AT,
    );
    for (const [id, mode, delivery] of [
      ['prj_copies', 'worktree', 'pull_request'],
      ['prj_folder', 'shared', 'pull_request'],
      ['prj_local', 'shared', 'local'],
    ] as const) {
      run(
        `INSERT INTO projects (id, name, repo_path, gate_command, areas, hazards, max_lanes, provider, account_id,
           handoff_pct, nudge_pct, human_wait_minutes, delivery, workspace_mode, created_at, updated_at)
         VALUES (?, ?, ?, 'true', '[]', '[]', 2, 'claude', 'acc_x', 40, 50, 10, ?, ?, ?, ?)`,
        id,
        id,
        `/tmp/${id}`,
        delivery,
        mode,
        AT,
        AT,
      );
      for (const [suffix, status] of [
        ['open', 'open'],
        ['done', 'done'],
      ] as const)
        run(
          `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, areas, status, board_order,
             workspace_mode, created_at, updated_at)
           VALUES (?, ?, 't', '', '[]', '[]', ?, 1, 'shared', ?, ?)`,
          `tsk_${id}_${suffix}`,
          id,
          status,
          AT,
          AT,
        );
    }
    run(
      `INSERT INTO workstreams (id, task_id, project_id, state, next_action, attempt, recovery_attempts, model,
         effort, fence, created_at, updated_at)
       VALUES ('wst_a', 'tsk_prj_copies_done', 'prj_copies', 'DONE', '{"kind":"start"}', 0, 0, 'sonnet', 'medium', 0, ?, ?)`,
      AT,
      AT,
    );
    migrateDatabase(db);
  });

  it('sets worktree on every task of a worktree-mode project, started or not, and shared on the rest', () => {
    const rows = db.$client
      .prepare('SELECT id, workspace_mode, placement_reason FROM tasks ORDER BY id')
      .all();
    expect(rows).toEqual([
      { id: 'tsk_prj_copies_done', workspace_mode: 'worktree', placement_reason: null },
      { id: 'tsk_prj_copies_open', workspace_mode: 'worktree', placement_reason: null },
      { id: 'tsk_prj_folder_done', workspace_mode: 'shared', placement_reason: null },
      { id: 'tsk_prj_folder_open', workspace_mode: 'shared', placement_reason: null },
      { id: 'tsk_prj_local_done', workspace_mode: 'shared', placement_reason: null },
      { id: 'tsk_prj_local_open', workspace_mode: 'shared', placement_reason: null },
    ]);
  });

  it('backfills every project to isolate migrations and deps, and keeps its default mode', () => {
    const rows = db.$client
      .prepare('SELECT id, workspace_mode, isolate FROM projects ORDER BY id')
      .all() as { id: string; workspace_mode: string; isolate: string }[];
    expect(rows.map((r): unknown[] => [r.id, r.workspace_mode, JSON.parse(r.isolate)])).toEqual([
      ['prj_copies', 'worktree', ['migrations', 'deps']],
      ['prj_folder', 'shared', ['migrations', 'deps']],
      ['prj_local', 'shared', ['migrations', 'deps']],
    ]);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('migrating to Shape sessions (Shape spec §5.1, §13)', () => {
  const AT = '2026-11-02T12:00:00.000Z';

  beforeEach(() => {
    // The last migration before a session could belong to a Shape conversation.
    migrateDatabase(db, migrationsThrough('0026_workstream_failure_kind'));
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
       VALUES ('tsk_a', 'prj_a', 't', '', '[]', '[]', 'open', 1, 'shared', ?, ?)`,
      AT,
      AT,
    );
    run(
      `INSERT INTO workstreams (id, task_id, project_id, state, next_action, attempt, recovery_attempts,
         model, effort, fence, created_at, updated_at)
       VALUES ('wst_a', 'tsk_a', 'prj_a', 'RUNNING', '"none"', 1, 0, 'sonnet', 'medium', 1, ?, ?)`,
      AT,
      AT,
    );
    run(
      `INSERT INTO sessions (id, workstream_id, account_id, sequence, provider, model, effort, mode,
         mcp_token_hash, started_at, input_tokens, output_tokens, cached_tokens, created_at, updated_at)
       VALUES ('ses_a', 'wst_a', 'acc_x', 1, 'claude', 'sonnet', 'medium', 'managed', 'hash-a', ?, 120, 12, 3, ?, ?)`,
      AT,
      AT,
      AT,
    );
    run(
      `INSERT INTO handoffs (id, workstream_id, session_id, content, git_head, git_changed_files, git_commits, created_at)
       VALUES ('hof_a', 'wst_a', 'ses_a', '{}', 'abc', '[]', '[]', ?)`,
      AT,
    );
    run(`INSERT INTO sources (id, kind, ref, created_at) VALUES ('src_a', 'builder', '{}', ?)`, AT);
    run(
      `INSERT INTO decisions (id, project_id, question, choice, rationale, decided_by, scope, source_id,
         created_at, updated_at)
       VALUES ('dec_a', 'prj_a', 'Which queue library?', 'BullMQ', 'Redis', 'me', 'project', 'src_a', ?, ?)`,
      AT,
      AT,
    );
    migrateDatabase(db);
  });

  it('keeps a lane session and its handoff, with no shape', () => {
    expect(
      db.$client.prepare('SELECT id, workstream_id, shape_id, input_tokens FROM sessions').all(),
    ).toEqual([{ id: 'ses_a', workstream_id: 'wst_a', shape_id: null, input_tokens: 120 }]);
    expect(db.$client.prepare('SELECT id, session_id FROM handoffs').all()).toEqual([
      { id: 'hof_a', session_id: 'ses_a' },
    ]);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });

  it('still enforces that a session has exactly one of a workstream and a shape', () => {
    expect(() =>
      db.$client.prepare("UPDATE sessions SET workstream_id = NULL WHERE id = 'ses_a'").run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('keeps decisions searchable and not withdrawn', () => {
    expect(
      db.$client
        .prepare(
          `SELECT d.id, d.withdrawn_at FROM decisions_fts f JOIN decisions d ON d.rowid = f.rowid
           WHERE decisions_fts MATCH 'queue'`,
        )
        .all(),
    ).toEqual([{ id: 'dec_a', withdrawn_at: null }]);
  });
});

describe('migrating to lane time (Shape spec §8)', () => {
  const AT = '2026-11-02T12:00:00.000Z';

  beforeEach(() => {
    // The last migration before task_lane_times.
    migrateDatabase(db, migrationsThrough('0030_shape_files_told'));
    const run = (sql: string, ...args: (string | number | null)[]): void => {
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
    // Finished with two ended sessions, finished with one never ended, and still running.
    const cases: readonly [string, string, readonly (readonly [string, string | null])[]][] = [
      [
        'wst_done',
        'DONE',
        [
          ['09:00', '09:30'],
          ['10:00', '10:45'],
        ],
      ],
      ['wst_open', 'DONE', [['09:00', null]]],
      ['wst_run', 'RUNNING', [['09:00', '09:10']]],
    ];
    const at = (hm: string): string => `2026-11-01T${hm}:00.000Z`;
    for (const [ws, state, spans] of cases) {
      const task = ws.replace('wst', 'tsk');
      run(
        `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, areas, status, board_order,
           workspace_mode, created_at, updated_at)
         VALUES (?, 'prj_a', 't', '', '[]', '[]', 'done', 1, 'shared', ?, ?)`,
        task,
        AT,
        AT,
      );
      run(
        `INSERT INTO workstreams (id, task_id, project_id, state, next_action, attempt, recovery_attempts,
           model, effort, fence, created_at, updated_at)
         VALUES (?, ?, 'prj_a', ?, '"none"', 1, 0, 'sonnet', 'medium', 1, ?, ?)`,
        ws,
        task,
        state,
        AT,
        AT,
      );
      spans.forEach(([start, end], i) => {
        run(
          `INSERT INTO sessions (id, workstream_id, account_id, sequence, provider, model, effort, mode,
             mcp_token_hash, started_at, ended_at, input_tokens, output_tokens, cached_tokens, created_at, updated_at)
           VALUES (?, ?, 'acc_x', ?, 'claude', 'sonnet', 'medium', 'managed', ?, ?, ?, 1, 1, 0, ?, ?)`,
          `ses_${ws}_${String(i)}`,
          ws,
          i + 1,
          `hash-${ws}-${String(i)}`,
          at(start),
          end === null ? null : at(end),
          AT,
          AT,
        );
      });
    }
    migrateDatabase(db);
  });

  it('backfills a finished workstream from its sessions alone, marked sessions-only', () => {
    const rows = db.$client
      .prepare('SELECT workstream_id, task_id, lane_minutes, sessions_only FROM task_lane_times')
      .all() as { lane_minutes: number }[];
    expect(rows.map((r) => ({ ...r, lane_minutes: Math.round(r.lane_minutes) }))).toEqual([
      { workstream_id: 'wst_done', task_id: 'tsk_done', lane_minutes: 75, sessions_only: 1 },
    ]);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('migrating to principles (M3 knowledge)', () => {
  const AT = '2026-11-03T12:00:00.000Z';

  beforeEach(() => {
    // The last migration before the principles table.
    migrateDatabase(db, migrationsThrough('0034_blue_blindfold'));
    const run = (sql: string, ...args: (string | number | null)[]): void => {
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
    run(`INSERT INTO sources (id, kind, ref, created_at) VALUES ('src_a', 'builder', '{}', ?)`, AT);
    run(
      `INSERT INTO decisions (id, project_id, question, choice, rationale, decided_by, scope, source_id,
         created_at, updated_at)
       VALUES ('dec_a', 'prj_a', 'Which queue library?', 'BullMQ', 'Redis', 'me', 'project', 'src_a', ?, ?)`,
      AT,
      AT,
    );
    run(
      `INSERT INTO decisions (id, project_id, question, choice, rationale, decided_by, scope, source_id,
         withdrawn_at, withdrawn_by, withdrawn_reason, created_at, updated_at)
       VALUES ('dec_w', 'prj_a', 'Which cache?', 'Memcached', 'Old', 'me', 'project', 'src_a',
         ?, 'me', 'wrong', ?, ?)`,
      AT,
      AT,
      AT,
    );
    run(
      `INSERT INTO proposals (id, project_id, kind, title, body, status, source_id, created_at, updated_at)
       VALUES ('prp_a', 'prj_a', 'note', 'A title', 'A body', 'pending', 'src_a', ?, ?)`,
      AT,
      AT,
    );
    migrateDatabase(db);
  });

  const principleHits = (term: string): unknown[] =>
    db.$client
      .prepare(
        `SELECT p.id FROM principles_fts f JOIN principles p ON p.rowid = f.rowid
         WHERE principles_fts MATCH ?`,
      )
      .pluck()
      .all(term);

  it('keeps every decision and its search results', () => {
    expect(db.$client.prepare('SELECT id, choice FROM decisions ORDER BY id').all()).toEqual([
      { id: 'dec_a', choice: 'BullMQ' },
      { id: 'dec_w', choice: 'Memcached' },
    ]);
    expect(
      db.$client
        .prepare(
          `SELECT d.id FROM decisions_fts f JOIN decisions d ON d.rowid = f.rowid
           WHERE decisions_fts MATCH 'queue'`,
        )
        .pluck()
        .all(),
    ).toEqual(['dec_a']);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });

  it('gains an empty principles table with a working full-text index', () => {
    expect(db.$client.prepare('SELECT count(*) FROM principles').pluck().get()).toBe(0);
    db.$client
      .prepare(
        `INSERT INTO principles (id, project_id, scope, statement, kind, topic_key, status, source_id,
           source_quote, created_at, updated_at)
         VALUES ('pri_a', 'prj_a', 'project', 'Never sleep in tests', 'policy', 'testing.no-sleeps',
           'confirmed', 'src_a', 'wait on a condition', ?, ?)`,
      )
      .run(AT, AT);
    expect(principleHits('sleep')).toEqual(['pri_a']);
    expect(principleHits('testing')).toEqual(['pri_a']);
    expect(principleHits('condition')).toEqual(['pri_a']);

    db.$client
      .prepare("UPDATE principles SET statement = 'Never poll in tests' WHERE id = 'pri_a'")
      .run();
    expect(principleHits('sleep')).toEqual([]);
    expect(principleHits('poll')).toEqual(['pri_a']);
  });

  it('keeps an existing proposal, linked to no principle', () => {
    expect(db.$client.prepare('SELECT id, title, principle_id FROM proposals').all()).toEqual([
      { id: 'prp_a', title: 'A title', principle_id: null },
    ]);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });

  it('indexes the decisions successor lookup', () => {
    expect(
      db.$client
        .prepare(
          "SELECT name FROM pragma_index_list('decisions') WHERE name = 'decisions_supersedes_idx'",
        )
        .pluck()
        .all(),
    ).toEqual(['decisions_supersedes_idx']);
  });
});

describe('migrating to principle and question links (Shape spec §13)', () => {
  const AT = '2026-11-03T12:00:00.000Z';
  const run = (sql: string, ...args: (string | number | null)[]): void => {
    db.$client.prepare(sql).run(...args);
  };
  const link = (id: string, target: Record<string, string>): void => {
    const columns = Object.keys(target);
    run(
      `INSERT INTO shape_links (id, shape_id, proposal_id, key, ${columns.map((c) => `${c}, `).join('')}created_at)
       VALUES (?, 'shp_a', 'shq_a', 'k', ${columns.map(() => '?, ').join('')}?)`,
      id,
      ...Object.values(target),
      AT,
    );
  };

  beforeEach(() => {
    // The last migration before shape_links could name a principle or a question.
    migrateDatabase(db, migrationsThrough('0038_green_sauron'));
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
       VALUES ('tsk_a', 'prj_a', 't', '', '[]', '[]', 'open', 1, 'shared', ?, ?)`,
      AT,
      AT,
    );
    run(`INSERT INTO sources (id, kind, ref, created_at) VALUES ('src_a', 'builder', '{}', ?)`, AT);
    run(
      `INSERT INTO decisions (id, project_id, question, choice, rationale, decided_by, scope, source_id,
         created_at, updated_at)
       VALUES ('dec_a', 'prj_a', 'Which queue library?', 'BullMQ', 'Redis', 'me', 'project', 'src_a', ?, ?)`,
      AT,
      AT,
    );
    run(
      `INSERT INTO shapes (id, project_id, title, state, origin, propose_unlocked, round, created_at, updated_at)
       VALUES ('shp_a', 'prj_a', 'Density', 'proposed', 'app', 1, 1, ?, ?)`,
      AT,
      AT,
    );
    run(
      `INSERT INTO shape_proposals (id, shape_id, key, kind, state, round, body, created_at, updated_at)
       VALUES ('shq_a', 'shp_a', 'k', 'task', 'accepted', 1, '{}', ?, ?)`,
      AT,
      AT,
    );
    link('slk_task', { task_id: 'tsk_a' });
    link('slk_decision', { decision_id: 'dec_a' });
    migrateDatabase(db);
  });

  it('keeps every existing link and leaves no dangling reference', () => {
    expect(
      db.$client.prepare('SELECT id, task_id, decision_id FROM shape_links ORDER BY id').all(),
    ).toEqual([
      { id: 'slk_decision', task_id: null, decision_id: 'dec_a' },
      { id: 'slk_task', task_id: 'tsk_a', decision_id: null },
    ]);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });

  it('links a principle or a question, and still demands exactly one target', () => {
    run(
      `INSERT INTO principles (id, project_id, scope, statement, kind, topic_key, status, source_id,
         created_at, updated_at)
       VALUES ('pri_a', 'prj_a', 'project', 'Never sleep in tests', 'policy', 'testing.no-sleeps',
         'confirmed', 'src_a', ?, ?)`,
      AT,
      AT,
    );
    run(
      `INSERT INTO shape_questions (id, shape_id, proposal_id, key, text, for_who, task_id, created_at)
       VALUES ('squ_a', 'shp_a', 'shq_a', 'q', 'Who pays?', 'finance', 'tsk_a', ?)`,
      AT,
    );
    expect(() => {
      link('slk_principle', { principle_id: 'pri_a' });
    }).not.toThrow();
    expect(() => {
      link('slk_question', { question_id: 'squ_a' });
    }).not.toThrow();
    expect(() => {
      link('slk_none', {});
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      link('slk_two', { principle_id: 'pri_a', task_id: 'tsk_a' });
    }).toThrow(/CHECK constraint failed/);
  });
});
