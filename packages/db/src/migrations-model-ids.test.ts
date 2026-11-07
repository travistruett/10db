import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_MIGRATIONS_DIR, migrateDatabase, openDatabase, type TendbDatabase } from './index';

const AT = '2026-10-21T12:00:00.000Z';
const LATER = '2026-11-02T12:00:00.000Z';
const MIGRATION = '0049_model_ids';

let dir: string;
let db: TendbDatabase;

beforeEach(() => {
  // A space in the path mirrors ~/Library/Application Support/10db.
  dir = mkdtempSync(join(tmpdir(), '10db model ids '));
  db = openDatabase(join(dir, '10db.sqlite'));
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The migrations that came before the one under test: a copy of the folder with its journal cut short. */
function migrationsBefore(tag: string): string {
  const before = join(dir, 'before');
  cpSync(DB_MIGRATIONS_DIR, before, { recursive: true });
  const journalPath = join(before, 'meta/_journal.json');
  // A journal this test just copied from the shipped migrations; the shape is known.
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const cut = journal.entries.findIndex((e) => e.tag === tag);
  const keep = new Set(journal.entries.slice(0, cut).map((e) => e.tag));
  journal.entries = journal.entries.filter((e) => keep.has(e.tag));
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  for (const file of readdirSync(before)) {
    if (file.endsWith('.sql') && !keep.has(file.slice(0, -'.sql'.length)))
      rmSync(join(before, file));
  }
  return before;
}

const sql = (text: string, ...values: unknown[]) => db.$client.prepare(text).run(...values);
const rows = <T>(text: string, ...values: unknown[]) =>
  db.$client.prepare(text).all(...values) as T[];

interface Profile {
  id: string;
  model: string;
  effort: string;
  enabled: number;
  steps_run: number;
  first_pass_steps: number;
  escalations: number;
  intelligence: number | null;
  cost_per_task_usd: number | null;
  measured_at: string | null;
  aa_slug: string | null;
}

const PROFILE = `INSERT INTO model_profiles (id, provider, model, effort, aa_slug, intelligence, cost_per_task_usd,
    source, measured_at, enabled, steps_run, first_pass_steps, escalations, created_at, updated_at)
  VALUES (?, 'claude', ?, ?, ?, ?, ?, 'aa', ?, ?, ?, ?, ?, ?, ?)`;

function seed(): void {
  db.$client.pragma('foreign_keys = OFF');
  sql(
    `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
     VALUES ('acc_x', 'gateway', 'gw', 'me', ?, 2, ?, ?)`,
    JSON.stringify({
      baseUrl: 'https://gw.example/api',
      modelMap: { sonnet: 'gw-sonnet' },
      aliases: ['sonnet', 'opus'],
    }),
    AT,
    AT,
  );
  sql(
    `INSERT INTO projects (id, name, repo_path, gate_command, areas, hazards, max_lanes, provider, account_id,
       handoff_pct, nudge_pct, human_wait_minutes, created_at, updated_at)
     VALUES ('prj_a', 'a', '/tmp/a', 'true', '[]', '[]', 2, 'claude', 'acc_x', 40, 50, 10, ?, ?)`,
    AT,
    AT,
  );
  sql(
    `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, areas, status,
       board_order, workspace_mode, created_at, updated_at)
     VALUES ('tsk_a', 'prj_a', 't', '', '[]', '[]', 'ready', 1, 'shared', ?, ?)`,
    AT,
    AT,
  );
  // sonnet@high has the steps and scores of a profile in use; opus@high collides with a canonical row that
  // reconcile already wrote; haiku@low collides with one that is measured more recently; fable has no match.
  sql(PROFILE, 'mpr_sonnet', 'sonnet', 'high', 'slug-sonnet', 41, 0.75, AT, 1, 7, 5, 2, AT, AT);
  sql(PROFILE, 'mpr_opus', 'opus', 'high', 'slug-opus', 45, 1, AT, 1, 4, 3, 1, AT, AT);
  sql(PROFILE, 'mpr_haiku', 'haiku', 'low', null, 20, 0.05, AT, 1, 2, 1, 0, AT, AT);
  sql(PROFILE, 'mpr_fable', 'fable', 'high', null, null, null, null, 0, 0, 0, 0, AT, AT);
  sql(
    PROFILE,
    'mpr_opus_new',
    'claude-opus-5-5',
    'high',
    null,
    null,
    null,
    null,
    1,
    1,
    1,
    0,
    LATER,
    LATER,
  );
  sql(
    PROFILE,
    'mpr_haiku_new',
    'claude-haiku-5-5',
    'low',
    null,
    21,
    0.06,
    LATER,
    1,
    3,
    3,
    0,
    LATER,
    LATER,
  );
  const step = (model: string, profileId: string | null) => ({
    role: 'implement',
    model,
    profileId,
    effort: 'high',
    reason: 'by score',
  });
  sql(
    `INSERT INTO workstreams (id, task_id, project_id, state, next_action, attempt, recovery_attempts,
       model, effort, steps, step_index, fence, created_at, updated_at)
     VALUES ('wst_a', 'tsk_a', 'prj_a', 'RUNNING', '"none"', 1, 0, 'sonnet', 'high', ?, 0, 1, ?, ?)`,
    JSON.stringify([
      step('sonnet', 'mpr_sonnet'),
      step('opus', 'mpr_opus'),
      step('gpt-6.1-sol', null),
    ]),
    AT,
    AT,
  );
  sql(
    `INSERT INTO personas (id, key, name, role, tools, instructions, skills, model_pin, archived, created_at, updated_at)
     VALUES ('per_a', 'pinned', 'Pinned', 'review', 'read_only', 'x', '[]', ?, 0, ?, ?)`,
    JSON.stringify({ model: 'opus', effort: 'high' }),
    AT,
    AT,
  );
  sql(
    `INSERT INTO personas (id, key, name, role, tools, instructions, skills, model_pin, archived, created_at, updated_at)
     VALUES ('per_b', 'unpinned', 'Unpinned', 'qa', 'read_only', 'x', '[]', NULL, 0, ?, ?)`,
    AT,
    AT,
  );
  sql(
    `INSERT INTO shapes (id, project_id, title, state, origin, round, model, created_at, updated_at)
     VALUES ('shp_a', 'prj_a', 's', 'OPEN', 'builder', 0, 'opus', ?, ?)`,
    AT,
    AT,
  );
  sql(
    `INSERT INTO sessions (id, workstream_id, account_id, sequence, provider, model, effort, mode, mcp_token_hash, started_at, input_tokens, output_tokens, created_at, updated_at)
     VALUES ('ses_a', 'wst_a', 'acc_x', 1, 'claude', 'sonnet', 'high', 'lane', 'hash', ?, 0, 0, ?, ?)`,
    AT,
    AT,
    AT,
  );
}

describe('the migration that renames stored model aliases', () => {
  beforeEach(() => {
    migrateDatabase(db, migrationsBefore(MIGRATION));
    seed();
    migrateDatabase(db);
  });

  const profile = (model: string, effort: string) =>
    rows<Profile>('SELECT * FROM model_profiles WHERE model = ? AND effort = ?', model, effort)[0];

  it('renames the four aliases in every column that names the model a row will run on', () => {
    expect(rows<{ model: string }>('SELECT model FROM workstreams')).toEqual([
      { model: 'claude-sonnet-5-5' },
    ]);
    const [stored] = rows<{ steps: string }>('SELECT steps FROM workstreams');
    const steps = JSON.parse(stored?.steps ?? '[]') as {
      model: string;
      profileId: string | null;
    }[];
    expect(steps.map((s) => s.model)).toEqual([
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'gpt-6.1-sol',
    ]);
    expect(
      rows<{ model_pin: string | null }>('SELECT model_pin FROM personas ORDER BY key'),
    ).toEqual([
      { model_pin: JSON.stringify({ model: 'claude-opus-5-5', effort: 'high' }) },
      { model_pin: null },
    ]);
    expect(rows<{ model: string }>('SELECT model FROM shapes')).toEqual([
      { model: 'claude-opus-5-5' },
    ]);
  });

  it('renames a profile and keeps its scores, step counts and slug', () => {
    expect(profile('claude-sonnet-5-5', 'high')).toMatchObject({
      id: 'mpr_sonnet',
      intelligence: 41,
      cost_per_task_usd: 0.75,
      steps_run: 7,
      first_pass_steps: 5,
      escalations: 2,
      aa_slug: 'slug-sonnet',
    });
    expect(profile('sonnet', 'high')).toBeUndefined();
  });

  it('turns Fable on', () => {
    expect(profile('claude-fable-5-1', 'high')?.enabled).toBe(1);
  });

  it('merges into a canonical row that exists: counts add, scores come from the row that has them', () => {
    expect(profile('claude-opus-5-5', 'high')).toMatchObject({
      id: 'mpr_opus_new',
      steps_run: 5,
      first_pass_steps: 4,
      escalations: 1,
      intelligence: 45,
      cost_per_task_usd: 1,
      measured_at: AT,
      aa_slug: 'slug-opus',
    });
    expect(profile('opus', 'high')).toBeUndefined();
  });

  it('merges into a canonical row measured more recently: its scores stay', () => {
    expect(profile('claude-haiku-5-5', 'low')).toMatchObject({
      id: 'mpr_haiku_new',
      steps_run: 5,
      intelligence: 21,
      cost_per_task_usd: 0.06,
      measured_at: LATER,
    });
  });

  it("points a step at the merged profile's row", () => {
    const [stored] = rows<{ steps: string }>('SELECT steps FROM workstreams');
    const steps = JSON.parse(stored?.steps ?? '[]') as { profileId: string | null }[];
    expect(steps.map((s) => s.profileId)).toEqual(['mpr_sonnet', 'mpr_opus_new', null]);
  });

  it('leaves what records history as written', () => {
    expect(rows<{ model: string }>('SELECT model FROM sessions')).toEqual([{ model: 'sonnet' }]);
  });

  it('drops the two account settings and keeps the others', () => {
    const [account] = rows<{ settings: string }>('SELECT settings FROM accounts');
    expect(JSON.parse(account?.settings ?? '{}')).toEqual({ baseUrl: 'https://gw.example/api' });
  });
});
