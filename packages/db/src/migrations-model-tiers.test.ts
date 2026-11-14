import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountSettings, WorkstreamStep } from '@10db/contracts';
import { z } from 'zod';
import { migrateDatabase, openDatabase, type TendbDatabase } from './index';
import { migrationsBefore } from './migrations-test-support';
import * as schema from './schema';

const AT = '2026-11-13T12:00:00.000Z';
const MIGRATION = '0067_four_model_rungs';

let dir: string;
let db: TendbDatabase;

beforeEach(() => {
  // A space in the path mirrors ~/Library/Application Support/10db.
  dir = mkdtempSync(join(tmpdir(), '10db model tiers '));
  db = openDatabase(join(dir, '10db.sqlite'));
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const sql = (text: string, ...values: unknown[]) => db.$client.prepare(text).run(...values);
/** The rows a query answers, read through the schema that says what the test expects of them. */
const rows = <S extends z.ZodType>(schema: S, text: string, ...values: unknown[]): z.infer<S>[] =>
  z.array(schema).parse(db.$client.prepare(text).all(...values));
/** A stored JSON column, parsed. */
const json = z.string().transform((text): unknown => JSON.parse(text));

const tier = (name: string) => JSON.stringify({ kind: 'tier', tier: name });

function seed(): void {
  db.$client.pragma('foreign_keys = OFF');
  sql(
    `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
     VALUES ('acc_a', 'gateway', 'both', 'me', ?, 2, ?, ?)`,
    JSON.stringify({
      baseUrl: 'https://gw.example/api',
      tierOverrides: { fast: 'small', balanced: 'mid', strongest: 'large' },
    }),
    AT,
    AT,
  );
  sql(
    `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
     VALUES ('acc_b', 'claude_subscription', 'none', 'me', '{}', 2, ?, ?)`,
    AT,
    AT,
  );
  sql(
    `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
     VALUES ('acc_c', 'gateway', 'one', 'me', ?, 2, ?, ?)`,
    JSON.stringify({ baseUrl: 'https://gw.example/api', tierOverrides: { strongest: 'only' } }),
    AT,
    AT,
  );
  sql(
    `INSERT INTO projects (id, name, repo_path, gate_command, areas, hazards, max_lanes, provider, account_id,
       handoff_pct, nudge_pct, human_wait_minutes, created_at, updated_at)
     VALUES ('prj_a', 'a', '/tmp/a', 'true', '[]', '[]', 2, 'claude', 'acc_a', 40, 50, 10, ?, ?)`,
    AT,
    AT,
  );
  for (const [id, setting] of [
    ['tsk_fast', tier('fast')],
    ['tsk_strongest', tier('strongest')],
    ['tsk_balanced', tier('balanced')],
    ['tsk_top', JSON.stringify({ kind: 'top_of_tier' })],
    ['tsk_model', JSON.stringify({ kind: 'model', model: 'fast' })],
    ['tsk_none', null],
  ] as const)
    sql(
      `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, areas, status,
         board_order, workspace_mode, model_setting, created_at, updated_at)
       VALUES (?, 'prj_a', 't', '', '[]', '[]', 'ready', 1, 'shared', ?, ?, ?)`,
      id,
      setting,
      AT,
      AT,
    );
  for (const [role, setting] of [
    ['plan', tier('strongest')],
    ['qa', tier('fast')],
    ['implement', tier('balanced')],
    ['review', JSON.stringify({ kind: 'model', model: 'strongest' })],
  ] as const)
    sql(
      `INSERT INTO role_settings (role, project_id, setting, updated_at) VALUES (?, NULL, ?, ?)`,
      role,
      setting,
      AT,
    );
  for (const [id, position, setting] of [
    ['pat_1', 0, tier('fast')],
    ['pat_2', 1, JSON.stringify({ kind: 'top_of_tier' })],
    ['pat_3', 2, tier('strongest')],
  ] as const)
    sql(
      `INSERT INTO patterns (id, project_id, name, match, setting, position, created_at, updated_at)
       VALUES (?, NULL, ?, '{"roles":[],"riskTags":[],"areas":[],"retryOnly":false}', ?, ?, ?, ?)`,
      id,
      id,
      setting,
      position,
      AT,
      AT,
    );
  for (const [id, model, value] of [
    ['mpr_1', 'small', 'fast'],
    ['mpr_2', 'mid', 'balanced'],
    ['mpr_3', 'large', 'strongest'],
    ['mpr_4', 'unranked', null],
  ] as const)
    sql(
      `INSERT INTO model_profiles (id, provider, model, effort, source, tier, enabled, steps_run,
         first_pass_steps, escalations, created_at, updated_at)
       VALUES (?, 'claude', ?, 'high', 'aa', ?, 1, 0, 0, 0, ?, ?)`,
      id,
      model,
      value,
      AT,
      AT,
    );
  // One step planned with a tier setting, one planned with nothing offered (its model is a tier name),
  // one on a real model with no setting, and one whose real model is named like a tier only by setting.
  const step = (model: string, setting: unknown, reason: string) => ({
    role: 'implement',
    personaId: null,
    personaName: 'Implementer',
    tools: 'edit',
    profileId: null,
    model,
    effort: 'high',
    need: 40,
    setting,
    reason,
    overBudget: false,
    pinned: false,
    status: 'pending',
    attempts: 0,
    startedAt: null,
    sessionFloor: 0,
    result: null,
  });
  sql(
    `INSERT INTO workstreams (id, task_id, project_id, state, next_action, attempt, recovery_attempts,
       model, effort, steps, step_index, fence, created_at, updated_at)
     VALUES ('wst_a', 'tsk_fast', 'prj_a', 'RUNNING', '"none"', 1, 0, 'strongest', 'high', ?, 0, 1, ?, ?)`,
    JSON.stringify([
      step('large', { kind: 'tier', tier: 'strongest' }, 'first'),
      step('fast', { kind: 'tier', tier: 'fast' }, 'second'),
      step('mid', null, 'third'),
      step('large', { kind: 'top_of_tier' }, 'fourth'),
      step('mid', { kind: 'tier', tier: 'balanced' }, 'fifth'),
    ]),
    AT,
    AT,
  );
  sql(
    `INSERT INTO workstreams (id, task_id, project_id, state, next_action, attempt, recovery_attempts,
       model, effort, steps, step_index, fence, created_at, updated_at)
     VALUES ('wst_b', 'tsk_strongest', 'prj_a', 'RUNNING', '"none"', 1, 0, 'mid', 'high', '[]', 0, 1, ?, ?)`,
    AT,
    AT,
  );
}

describe('the migration that turns three model tiers into four rungs', () => {
  beforeEach(() => {
    migrateDatabase(db, migrationsBefore(dir, MIGRATION));
    seed();
    migrateDatabase(db);
  });

  it('maps a task’s tier setting and leaves every other kind and none as it was', () => {
    expect(
      rows(
        z.object({ id: z.string(), model_setting: json.nullable() }),
        'SELECT * FROM tasks ORDER BY id',
      ).map((r) => [r.id, r.model_setting]),
    ).toEqual([
      ['tsk_balanced', { kind: 'tier', tier: 'balanced' }],
      ['tsk_fast', { kind: 'tier', tier: 'efficient' }],
      ['tsk_model', { kind: 'model', model: 'fast' }],
      ['tsk_none', null],
      ['tsk_strongest', { kind: 'tier', tier: 'capable' }],
      ['tsk_top', { kind: 'top_of_tier' }],
    ]);
  });

  it('maps a role’s and a pattern’s tier setting', () => {
    expect(
      rows(
        z.object({ role: z.string(), setting: json }),
        'SELECT role, setting FROM role_settings ORDER BY role',
      ).map((r) => [r.role, r.setting]),
    ).toEqual([
      ['implement', { kind: 'tier', tier: 'balanced' }],
      ['plan', { kind: 'tier', tier: 'capable' }],
      ['qa', { kind: 'tier', tier: 'efficient' }],
      ['review', { kind: 'model', model: 'strongest' }],
    ]);
    expect(
      rows(
        z.object({ id: z.string(), setting: json }),
        'SELECT id, setting FROM patterns ORDER BY position',
      ).map((r) => [r.id, r.setting]),
    ).toEqual([
      ['pat_1', { kind: 'tier', tier: 'efficient' }],
      ['pat_2', { kind: 'top_of_tier' }],
      ['pat_3', { kind: 'tier', tier: 'capable' }],
    ]);
  });

  it('maps a profile’s tier and leaves an unranked one empty', () => {
    expect(
      rows(
        z.object({ model: z.string(), tier: z.string().nullable() }),
        'SELECT model, tier FROM model_profiles ORDER BY id',
      ).map((r) => [r.model, r.tier]),
    ).toEqual([
      ['small', 'efficient'],
      ['mid', 'balanced'],
      ['large', 'capable'],
      ['unranked', null],
    ]);
  });

  it('maps each step’s setting and a step whose model is a tier name, in order', () => {
    const [stored] = rows(
      z.object({ model: z.string(), steps: json }),
      "SELECT model, steps FROM workstreams WHERE id = 'wst_a'",
    );
    expect(stored?.model).toBe('capable');
    expect(stored?.steps).toMatchObject([
      { model: 'large', setting: { kind: 'tier', tier: 'capable' }, reason: 'first' },
      { model: 'efficient', setting: { kind: 'tier', tier: 'efficient' }, reason: 'second' },
      { model: 'mid', setting: null, reason: 'third' },
      { model: 'large', setting: { kind: 'top_of_tier' }, reason: 'fourth' },
      { model: 'mid', setting: { kind: 'tier', tier: 'balanced' }, reason: 'fifth' },
    ]);
  });

  it('leaves a workstream on a real model with no steps alone', () => {
    expect(
      rows(
        z.object({ model: z.string(), steps: json }),
        "SELECT model, steps FROM workstreams WHERE id = 'wst_b'",
      ),
    ).toEqual([{ model: 'mid', steps: [] }]);
  });

  it('moves an account’s overrides: fast to efficient, strongest to both capable and frontier', () => {
    expect(
      rows(
        z.object({ id: z.string(), settings: json }),
        'SELECT id, settings FROM accounts ORDER BY id',
      ).map((r) => [r.id, r.settings]),
    ).toEqual([
      [
        'acc_a',
        {
          baseUrl: 'https://gw.example/api',
          tierOverrides: {
            balanced: 'mid',
            efficient: 'small',
            capable: 'large',
            frontier: 'large',
          },
        },
      ],
      ['acc_b', {}],
      [
        'acc_c',
        { baseUrl: 'https://gw.example/api', tierOverrides: { capable: 'only', frontier: 'only' } },
      ],
    ]);
  });

  it('leaves every migrated row readable by the code that reads it', () => {
    expect(
      db
        .select()
        .from(schema.roleSettings)
        .all()
        .map((r) => [r.role, r.setting]),
    ).toEqual(
      expect.arrayContaining([
        ['plan', { kind: 'tier', tier: 'capable' }],
        ['qa', { kind: 'tier', tier: 'efficient' }],
      ]),
    );
    expect(
      db
        .select()
        .from(schema.patterns)
        .orderBy(schema.patterns.position)
        .all()
        .map((p) => p.setting),
    ).toEqual([
      { kind: 'tier', tier: 'efficient' },
      { kind: 'top_of_tier' },
      { kind: 'tier', tier: 'capable' },
    ]);
    const settings = rows(
      z.object({ settings: json }),
      'SELECT settings FROM accounts ORDER BY id',
    );
    expect(settings.map((r) => AccountSettings.safeParse(r.settings).success)).toEqual([
      true,
      true,
      true,
    ]);
    const [stored] = rows(
      z.object({ steps: json }),
      "SELECT steps FROM workstreams WHERE id = 'wst_a'",
    );
    expect(WorkstreamStep.array().parse(stored?.steps)).toHaveLength(5);
  });
});
