import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idUuid, mintId, type IdKind, type IdOf } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { migrateDatabase, openDatabase, type TendbDatabase } from './index';
import { migrationsBefore } from './migrations-test-support';
import { accountSpendUsd, accountUsage } from './store/usage';

/** The first of the three migrations a plan's move into sessions adds. */
const MIGRATION = '0095_round_freak';

let dir: string;
let db: TendbDatabase;

const at = (minute: number): string => new Date(Date.UTC(2026, 10, 1, 12, minute)).toISOString();
const run = (text: string, ...values: unknown[]) => db.$client.prepare(text).run(...values);
const rows = <S extends z.ZodType>(schema: S, text: string, ...values: unknown[]): z.infer<S>[] =>
  z.array(schema).parse(db.$client.prepare(text).all(...values));
const count = (table: string, where = '1 = 1', ...values: unknown[]): number =>
  z.number().parse(
    db.$client
      .prepare(`SELECT count(*) FROM ${table} WHERE ${where}`)
      .pluck()
      .get(...values),
  );
const after = (id: IdOf<IdKind>, prefix: string): string => `${prefix}_${idUuid(id)}`;

const ACC = mintId('Account');
const PROJ = mintId('Project');
const WINDOW = { month: '2026-11', start: at(-60), end: at(600) };

const planA = mintId('Shape');
const planB = mintId('Shape');
const convA = mintId('Conversation');
const convB = mintId('Conversation');
const convChat = mintId('Conversation');
const chatOrdinary = mintId('Chat');
const taskA = mintId('Task');
const taskOther = mintId('Task');
const goalA = mintId('Goal');
const decisionB = mintId('Decision');
const principle = mintId('Principle');
const revisionA = mintId('ShapeAttachmentRevision');
const attachmentA = mintId('ShapeAttachment');
const proposalA = mintId('ShapeProposal');
const proposalB = mintId('ShapeProposal');
const entryB = mintId('ShapeEntry');
const queuedStarter = mintId('ConversationItem');
const itemB = mintId('ConversationItem');
const pastedPicture = mintId('ConversationFile');
const planFile = mintId('ConversationFile');
const sessionA = mintId('Session');
const sessionB = mintId('Session');
const sessionBOpen = mintId('Session');
const group = mintId('LandingGroup');

const PROJECT = `INSERT INTO projects (id, name, repo_path, gate_command, areas, hazards, max_lanes, provider,
    account_id, handoff_pct, nudge_pct, human_wait_minutes, created_at, updated_at)
  VALUES (?, 'p', '/tmp/p', 'true', '[]', '[]', 2, 'claude', ?, 40, 50, 10, ?, ?)`;
const TASK = `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, areas, status, board_order,
    workspace_mode, created_at, updated_at)
  VALUES (?, ?, 't', '', '[]', '[]', 'open', 1, 'shared', ?, ?)`;
const CONVERSATION = `INSERT INTO conversations (id, project_id, owner_kind, owner_id, profile, account_id, effort,
    created_at, updated_at) VALUES (?, ?, ?, ?, 'explore', ?, ?, ?, ?)`;
const ITEM = `INSERT INTO conversation_items (id, conversation_id, seq, author, kind, body, push_uuids, created_at,
    updated_at, pushed_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, NULL, NULL)`;
const SESSION = `INSERT INTO sessions (id, conversation_id, account_id, sequence, provider, model, effort, mode,
    mcp_token_hash, started_at, ended_at, input_tokens, output_tokens, cost_usd, created_at, updated_at)
  VALUES (?, ?, ?, 1, 'claude', 'sonnet', 'medium', 'default', ?, ?, ?, 10, 20, ?, ?, ?)`;

function seed(): void {
  db.$client.pragma('foreign_keys = ON');
  run(
    `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
     VALUES (?, 'claude_subscription', 'a', '', '{}', 2, ?, ?)`,
    ACC,
    at(0),
    at(0),
  );
  run(PROJECT, PROJ, ACC, at(0), at(0));
  run(TASK, taskA, PROJ, at(1), at(1));
  run(TASK, taskOther, PROJ, at(1), at(1));
  run(
    `INSERT INTO people (id, handle, name, is_builder, created_at, updated_at) VALUES ('per_x', 'b', 'B', 1, ?, ?)`,
    at(0),
    at(0),
  );
  run(
    `INSERT INTO goals (id, project_id, title, objective, owner_id, created_at, updated_at)
     VALUES (?, ?, 'g', 'o', 'per_x', ?, ?)`,
    goalA,
    PROJ,
    at(1),
    at(1),
  );
  run(`INSERT INTO sources (id, kind, ref, created_at) VALUES ('src_x', 'builder', 'x', ?)`, at(0));
  run(
    `INSERT INTO decisions (id, question, choice, rationale, decided_by, scope, source_id, created_at, updated_at)
     VALUES (?, 'q', 'c', 'r', 'builder', 'project', 'src_x', ?, ?)`,
    decisionB,
    at(1),
    at(1),
  );
  run(
    `INSERT INTO principles (id, scope, statement, kind, topic_key, status, source_id, created_at, updated_at)
     VALUES (?, 'project', 'st', 'rule', 'tk', 'active', 'src_x', ?, ?)`,
    principle,
    at(1),
    at(1),
  );
  for (const [id, title, effort] of [
    [planA, 'Plan A', 'high'],
    [planB, 'Plan B', null],
  ] as const)
    run(
      `INSERT INTO shapes (id, project_id, title, state, origin, effort, created_at, updated_at)
       VALUES (?, ?, ?, 'open', 'new', ?, ?, ?)`,
      id,
      PROJ,
      title,
      effort,
      at(2),
      at(3),
    );
  run(CONVERSATION, convA, PROJ, 'shape', planA, ACC, null, at(2), at(2));
  run(CONVERSATION, convB, PROJ, 'shape', planB, ACC, null, at(2), at(2));

  // Plan A fed the Board.
  run(
    `INSERT INTO landing_groups (id, project_id, title, shape_id, created_at, updated_at) VALUES (?, ?, 'lg', ?, ?, ?)`,
    group,
    PROJ,
    planA,
    at(4),
    at(4),
  );
  run(
    `INSERT INTO shape_proposals (id, shape_id, key, kind, state, round, body, created_at, updated_at)
     VALUES (?, ?, 'k', 'task', 'proposed', 1, '{}', ?, ?)`,
    proposalA,
    planA,
    at(4),
    at(4),
  );
  run(
    `INSERT INTO shape_attachments (id, shape_id, kind, key, body, created_at, updated_at)
     VALUES (?, ?, 'doc', 'd', 'body', ?, ?)`,
    attachmentA,
    planA,
    at(4),
    at(4),
  );
  run(
    `INSERT INTO shape_attachment_revisions (id, attachment_id, number, body, sha256, sections, created_at, updated_at)
     VALUES (?, ?, 1, 'body', 'h', '[]', ?, ?)`,
    revisionA,
    attachmentA,
    at(4),
    at(4),
  );
  run(
    `INSERT INTO shape_findings (id, shape_id, effort_key, reviewer, kind, text, state, round, created_at, updated_at)
     VALUES (?, ?, 'e', 'r', 'gap', 'x', 'open', 1, ?, ?)`,
    mintId('ShapeFinding'),
    planA,
    at(4),
    at(4),
  );
  run(
    `INSERT INTO task_context (task_id, shape_id, revision_id, section, shared, cites, created_at, updated_at)
     VALUES (?, ?, ?, 's', 0, '[]', ?, ?)`,
    taskA,
    planA,
    revisionA,
    at(5),
    at(5),
  );
  for (const [col, target] of [
    ['goal_id', goalA],
    ['task_id', taskA],
  ] as const)
    run(
      `INSERT INTO shape_links (id, shape_id, proposal_id, key, ${col}, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      mintId('ShapeLink'),
      planA,
      proposalA,
      col,
      target,
      at(5),
    );
  run(
    ITEM,
    mintId('ConversationItem'),
    convA,
    1,
    'builder',
    'message',
    '{"text":"hi"}',
    at(6),
    at(6),
  );
  run(
    ITEM,
    queuedStarter,
    convA,
    2,
    'system',
    'shape_event',
    '{"kind":"propose","text":"Propose","prompt":"Propose now","rehearsing":[]}',
    at(7),
    at(7),
  );
  run(
    `INSERT INTO conversation_files (id, conversation_id, item_id, name, media_type, size, stored_path, created_at)
     VALUES (?, ?, NULL, 'plan.md', 'text/markdown', 5, '/f/plan.md', ?)`,
    planFile,
    convA,
    at(6),
  );
  run(SESSION, sessionA, convA, ACC, 'h1', at(8), at(9), 0.5, at(8), at(9));

  // Plan B fed nothing.
  run(
    `INSERT INTO shape_proposals (id, shape_id, key, kind, state, round, body, created_at, updated_at)
     VALUES (?, ?, 'k', 'decision', 'proposed', 1, '{}', ?, ?)`,
    proposalB,
    planB,
    at(4),
    at(4),
  );
  run(
    `INSERT INTO shape_links (id, shape_id, proposal_id, key, decision_id, created_at) VALUES (?, ?, ?, 'dec', ?, ?)`,
    mintId('ShapeLink'),
    planB,
    proposalB,
    decisionB,
    at(5),
  );
  run(ITEM, itemB, convB, 1, 'builder', 'message', '{"text":"hello"}', at(6), at(6));
  run(
    `INSERT INTO shape_entries (id, shape_id, key, kind, title, body, anchors, sources, verified, state, created_at,
       updated_at) VALUES (?, ?, 'e', 'fact', 't', 'b', '[]', '[]', 0, 'active', ?, ?)`,
    entryB,
    planB,
    at(4),
    at(4),
  );
  run(
    `INSERT INTO shape_entry_versions (id, entry_id, number, snapshot, created_at) VALUES (?, ?, 1, '{}', ?)`,
    mintId('ShapeEntryVersion'),
    entryB,
    at(4),
  );
  run(
    `INSERT INTO shape_shadow_answers (shape_id, message_id, decision, answer, confidence, judge_call_id, created_at)
     VALUES (?, ?, 'shape_ready', 'yes', 0.9, ?, ?)`,
    planB,
    itemB,
    mintId('JudgeCall'),
    at(6),
  );
  run(SESSION, sessionB, convB, ACC, 'h2', at(10), at(11), 1.25, at(10), at(11));
  // Left open by a crash.
  run(SESSION, sessionBOpen, convB, ACC, 'h3', at(12), null, null, at(12), at(12));

  // Neither plan's: an ordinary chat holding a pasted picture.
  run(CONVERSATION, convChat, PROJ, 'chat', chatOrdinary, ACC, null, at(2), at(2));
  run(
    `INSERT INTO chats (id, project_id, conversation_id, title, title_source, mode, tab_position, created_at,
       updated_at) VALUES (?, ?, ?, 'chat', 'agent', 'explore', 0, ?, ?)`,
    chatOrdinary,
    PROJ,
    convChat,
    at(2),
    at(2),
  );
  const message = mintId('ConversationItem');
  run(ITEM, message, convChat, 1, 'builder', 'message', '{"text":"see"}', at(6), at(6));
  run(
    `INSERT INTO conversation_files (id, conversation_id, item_id, name, media_type, size, stored_path, created_at)
     VALUES (?, ?, ?, 'p.png', 'image/png', 5, '/f/p.png', ?)`,
    pastedPicture,
    convChat,
    message,
    at(6),
  );
}

let spendBefore = 0;
let totalBefore: unknown = null;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), '10db plans into sessions '));
  db = openDatabase(join(dir, '10db.sqlite'));
  migrateDatabase(db, migrationsBefore(dir, MIGRATION));
  seed();
  spendBefore = accountSpendUsd(db, ACC, WINDOW);
  totalBefore = accountUsage(db, ACC, WINDOW).total;
  migrateDatabase(db);
  db.$client.pragma('foreign_keys = ON');
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the plans-into-sessions migration', () => {
  it('keeps a plan that fed the Board as an archived chat over its conversation', () => {
    const chatA = after(planA, 'cht');
    expect(
      rows(z.object({ chat_id: z.string() }), 'SELECT chat_id FROM shapes WHERE id = ?', planA),
    ).toEqual([{ chat_id: chatA }]);
    const [chat] = rows(
      z.object({
        conversation_id: z.string(),
        title: z.string(),
        tab_position: z.number().nullable(),
        archived_at: z.string().nullable(),
      }),
      'SELECT conversation_id, title, tab_position, archived_at FROM chats WHERE id = ?',
      chatA,
    );
    expect(chat).toMatchObject({ conversation_id: convA, title: 'Plan A', tab_position: null });
    expect(chat?.archived_at).not.toBeNull();
    expect(
      rows(
        z.object({ owner_kind: z.string(), owner_id: z.string(), effort: z.string().nullable() }),
        'SELECT owner_kind, owner_id, effort FROM conversations WHERE id = ?',
        convA,
      ),
    ).toEqual([{ owner_kind: 'chat', owner_id: chatA, effort: 'high' }]);
    expect(count('task_context', 'shape_id = ?', planA)).toBe(1);
    expect(count('landing_groups', 'shape_id = ?', planA)).toBe(1);
    expect(count('shape_links', 'shape_id = ?', planA)).toBe(2);
    expect(count('shape_proposals', 'shape_id = ?', planA)).toBe(1);
    expect(count('shape_attachment_revisions', 'id = ?', revisionA)).toBe(1);
    expect(count('shape_findings', 'shape_id = ?', planA)).toBe(1);
    expect(count('conversation_items', 'conversation_id = ?', convA)).toBe(2);
    expect(count('conversation_files', 'id = ? AND item_id IS NULL', planFile)).toBe(1);
    expect(count('sessions', 'id = ? AND conversation_id = ?', sessionA, convA)).toBe(1);
    // The queued press stays in the transcript but starts nothing.
    expect(
      rows(
        z.object({ prompt: z.string().nullable() }),
        "SELECT json_extract(body, '$.prompt') AS prompt FROM conversation_items WHERE id = ?",
        queuedStarter,
      ),
    ).toEqual([{ prompt: null }]);
  });

  it('deletes a plan that fed nothing, and keeps its sessions, cost and decision', () => {
    for (const [table, where] of [
      ['shapes', 'id = ?'],
      ['shape_proposals', 'shape_id = ?'],
      ['shape_links', 'shape_id = ?'],
      ['shape_entries', 'shape_id = ?'],
      ['shape_shadow_answers', 'shape_id = ?'],
    ] as const)
      expect(count(table, where, planB), table).toBe(0);
    expect(count('shape_entry_versions', 'entry_id = ?', entryB)).toBe(0);
    expect(count('conversations', 'id = ?', convB)).toBe(0);
    expect(count('conversation_items', 'conversation_id = ?', convB)).toBe(0);
    expect(count('decisions', 'id = ?', decisionB)).toBe(1);
    expect(
      rows(
        z.object({ conversation_id: z.null(), cost_usd: z.number().nullable() }),
        'SELECT conversation_id, cost_usd FROM sessions WHERE id = ?',
        sessionB,
      ),
    ).toEqual([{ conversation_id: null, cost_usd: 1.25 }]);
    expect(
      rows(
        z.object({ ended_at: z.string(), exit_reason: z.string() }),
        'SELECT ended_at, exit_reason FROM sessions WHERE id = ?',
        sessionBOpen,
      ),
    ).toHaveLength(1);
    expect(accountSpendUsd(db, ACC, WINDOW)).toBe(spendBefore);
    expect(accountUsage(db, ACC, WINDOW).total).toEqual(totalBefore);
  });

  it('leaves everything else alone and no dangling reference', () => {
    expect(count('chats', 'id = ?', chatOrdinary)).toBe(1);
    expect(count('conversation_files', 'id = ? AND item_id IS NOT NULL', pastedPicture)).toBe(1);
    expect(count('tasks', 'id IN (?, ?)', taskA, taskOther)).toBe(2);
    expect(count('principles', 'id = ?', principle)).toBe(1);
    expect(count('decisions', 'id = ?', decisionB)).toBe(1);
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(count('conversations', "owner_kind = 'shape'")).toBe(0);
  });
});
