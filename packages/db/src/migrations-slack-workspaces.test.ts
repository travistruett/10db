import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { migrateDatabase, openDatabase, type TendbDatabase } from './index';
import { migrationsBefore } from './migrations-test-support';

const AT = '2026-11-20T12:00:00.000Z';
const MIGRATION = '0106_slack_workspaces';

let dir: string;
let db: TendbDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '10db slack workspaces '));
  db = openDatabase(join(dir, '10db.sqlite'));
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const sql = (text: string, ...values: unknown[]) => db.$client.prepare(text).run(...values);
const rows = <S extends z.ZodType>(schema: S, text: string, ...values: unknown[]): z.infer<S>[] =>
  z.array(schema).parse(db.$client.prepare(text).all(...values));

function insertCard(id: string): void {
  sql(
    `INSERT INTO inbox_items (id, project_id, kind, state, title, body, options, category, urgency, assignee,
       assignees, rule_assignees, routed_by, route_suggestion, targets, created_at, updated_at)
     VALUES (?, 'prj_1', 'question', 'open', 't', 'b', '[]', 'product', 'normal', 'mark', '["mark"]',
       '["mark"]', 'rule', '{"personIds":["per_mark"],"confidence":1}', '[]', ?, ?)`,
    id,
    AT,
    AT,
  );
}

function insertSend(id: string, card: string, state: string, userId: string | null): void {
  sql(
    `INSERT INTO stakeholder_sends (id, inbox_item_id, state, text, hits, created_at, updated_at)
     VALUES (?, ?, ?, 'q', '[]', ?, ?)`,
    id,
    card,
    state,
    AT,
    AT,
  );
  if (userId !== null) {
    sql(
      `INSERT INTO stakeholder_send_people (send_id, user_id, person_id, name, recipient, position)
       VALUES (?, ?, 'per_mark', 'Mark', 1, 0)`,
      id,
      userId,
    );
  }
}

function seed(withWorkspace: boolean): void {
  sql(
    `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
     VALUES ('acc_1', 'anthropic_api_key', 'a', 'me', '{}', 2, ?, ?)`,
    AT,
    AT,
  );
  for (const id of ['prj_1', 'prj_2']) {
    sql(
      `INSERT INTO projects (id, name, repo_path, gate_command, areas, hazards, max_lanes, provider, account_id,
         handoff_pct, nudge_pct, human_wait_minutes, created_at, updated_at)
       VALUES (?, ?, ?, 'true', '[]', '[]', 2, 'claude', 'acc_1', 40, 50, 10, ?, ?)`,
      id,
      id,
      `/tmp/${id}`,
      AT,
      AT,
    );
  }
  if (withWorkspace) {
    sql(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('slack.workspaces', ?, ?)`,
      JSON.stringify([{ teamId: 'W', teamName: 'Work' }]),
      AT,
    );
    sql(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('slack.prj_2', '{"teamId":null}', ?)`,
      AT,
    );
  }
  sql(
    `INSERT INTO people (id, handle, name, is_builder, created_at, updated_at) VALUES ('per_mark', 'mark', 'Mark', 0, ?, ?)`,
    AT,
    AT,
  );
  sql(
    `INSERT INTO person_contacts (id, person_id, team_id, user_id, dm_channel_id, send_mode, created_at, updated_at)
     VALUES ('pct_mark', 'per_mark', 'W', 'UM', 'D1', 'auto', ?, ?)`,
    AT,
    AT,
  );
  insertCard('inb_1');
  insertCard('inb_2');
  insertSend('ssd_1', 'inb_1', 'sent', 'UM');
  // Its recipient's contact is gone (a different Slack user), so only a signed-in workspace can place it.
  insertSend('ssd_2', 'inb_2', 'sent', 'UGONE');
}

const Send = z.object({
  id: z.string(),
  team_id: z.string().nullable(),
  state: z.string(),
  error: z.string().nullable(),
});
const sends = () =>
  rows(Send, 'SELECT id, team_id, state, error FROM stakeholder_sends ORDER BY id');
const Setting = z.object({ key: z.string(), value: z.string() });
const slackSettings = () =>
  rows(Setting, `SELECT key, value FROM app_settings WHERE key LIKE 'slack.prj_%' ORDER BY key`);

function migrate(withWorkspace: boolean): void {
  migrateDatabase(db, migrationsBefore(dir, MIGRATION));
  seed(withWorkspace);
  migrateDatabase(db);
}

describe('the migrations that bind Slack to a workspace', () => {
  it('with one workspace signed in, places every send and project and keeps every contact', () => {
    migrate(true);
    expect.soft(sends().map((s) => [s.id, s.team_id, s.state])).toEqual([
      ['ssd_1', 'W', 'sent'],
      ['ssd_2', 'W', 'sent'],
    ]);
    expect(slackSettings()).toEqual([
      { key: 'slack.prj_1', value: '{"teamId":"W"}' },
      { key: 'slack.prj_2', value: '{"teamId":null}' },
    ]);
    expect(rows(z.object({ n: z.number() }), 'SELECT count(*) AS n FROM person_contacts')).toEqual([
      { n: 1 },
    ]);
    expect(rows(z.object({ user_id: z.string() }), 'SELECT user_id FROM person_contacts')).toEqual([
      { user_id: 'UM' },
    ]);
    sql(
      `INSERT INTO person_contacts (id, person_id, team_id, user_id, send_mode, created_at, updated_at)
       VALUES ('pct_2', 'per_mark', 'W2', 'UM2', 'auto', ?, ?)`,
      AT,
      AT,
    );
    expect(() =>
      sql(
        `INSERT INTO person_contacts (id, person_id, team_id, user_id, send_mode, created_at, updated_at)
         VALUES ('pct_3', 'per_mark', 'W', 'UM3', 'auto', ?, ?)`,
        AT,
        AT,
      ),
    ).toThrow(/UNIQUE/);
  });

  it('with no workspace, binds nothing and fails the send it cannot place, handing its card to the builder', () => {
    migrate(false);
    expect(slackSettings()).toEqual([]);
    expect(sends().map((s) => [s.id, s.team_id, s.state, s.error])).toEqual([
      ['ssd_1', 'W', 'sent', null],
      ['ssd_2', null, 'failed', 'no_workspace'],
    ]);
    expect(
      rows(
        z.object({
          id: z.string(),
          assignee: z.string(),
          assignees: z.string(),
          routed_by: z.string(),
          suggested: z.number(),
        }),
        'SELECT id, assignee, assignees, routed_by, route_suggestion IS NOT NULL AS suggested FROM inbox_items ORDER BY id',
      ),
    ).toEqual([
      {
        id: 'inb_1',
        assignee: 'mark',
        assignees: '["mark"]',
        routed_by: 'rule',
        suggested: 1,
      },
      {
        id: 'inb_2',
        assignee: 'me',
        assignees: '["me"]',
        routed_by: 'builder',
        suggested: 0,
      },
    ]);
  });
});
