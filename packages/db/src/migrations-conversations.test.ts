import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationFileId,
  ConversationItemId,
  idUuid,
  mintId,
  ToolCallView,
  type IdKind,
  type IdOf,
} from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { migrateDatabase, openDatabase, type TendbDatabase } from './index';
import { migrationsBefore } from './migrations-test-support';
import { shapeItemOf, taskItemOf } from './store/transcript-kinds';

const MIGRATION = '0075_conversation_tables';

let dir: string;
let db: TendbDatabase;

const at = (minute: number): string => new Date(Date.UTC(2026, 10, 1, 12, minute)).toISOString();
const sql = (text: string, ...values: unknown[]) => db.$client.prepare(text).run(...values);
/** The rows a query answers, read through the schema that says what the test expects of them. */
const rows = <S extends z.ZodType>(schema: S, text: string, ...values: unknown[]): z.infer<S>[] =>
  z.array(schema).parse(db.$client.prepare(text).all(...values));
const column = (text: string, ...values: unknown[]): unknown[] =>
  db.$client
    .prepare(text)
    .pluck()
    .all(...values);
const cnv = (id: IdOf<IdKind>): string => `cnv_${idUuid(id)}`;

const A = mintId('Account');
const B = mintId('Account');
const P = mintId('Project');
const P2 = mintId('Project');
const S1 = mintId('Shape');
const T1 = mintId('Task');
const S2 = mintId('Shape');
const T3 = mintId('Task');
const S3 = mintId('Shape');
const T2 = mintId('Task');
const W1 = mintId('Workstream');
const W2 = mintId('Workstream');
const W3 = mintId('Workstream');
const PA = mintId('Pass');
const PT1 = mintId('PassTurn');

interface ShapeRow {
  readonly id: ConversationItemId;
  readonly shapeId: IdOf<'Shape'>;
  readonly author: 'builder' | 'claude' | 'note';
  readonly kind:
    'text' | 'tool' | 'notice' | 'digest' | 'propose' | 'rehearse' | 'edit' | 'event' | 'screen';
  readonly body: string;
  readonly createdAt: string;
}
interface TaskRow {
  readonly id: ConversationItemId;
  readonly taskId: IdOf<'Task'>;
  readonly author: 'builder' | 'agent' | 'system';
  readonly kind: 'message' | 'reply' | 'notice';
  readonly body: string;
  readonly createdAt: string;
  readonly pushedAt: string | null;
  readonly pushUuids: readonly string[];
  readonly deliveredAt: string | null;
  readonly turnId: IdOf<'PassTurn'> | null;
}

const S1_LINES: readonly Pick<ShapeRow, 'author' | 'kind' | 'body'>[] = [
  { author: 'builder', kind: 'text', body: 'Plan the importer.' },
  { author: 'claude', kind: 'text', body: 'Reading the code first.' },
  { author: 'claude', kind: 'tool', body: 'Read · src/a.ts' },
  { author: 'note', kind: 'notice', body: 'The account changed.' },
  { author: 'note', kind: 'digest', body: 'So far: an importer.' },
  { author: 'note', kind: 'propose', body: 'Propose' },
  { author: 'note', kind: 'rehearse', body: 'Rehearse' },
  { author: 'note', kind: 'edit', body: 'The builder edited a task.' },
  { author: 'note', kind: 'event', body: 'A task merged.' },
  { author: 'claude', kind: 'screen', body: JSON.stringify({ path: 'a.png', url: '/' }) },
  { author: 'claude', kind: 'tool', body: `Grep · ${'x'.repeat(293)}` },
  { author: 'claude', kind: 'tool', body: '🙂'.repeat(150) },
];
const S3_LINES: readonly Pick<ShapeRow, 'author' | 'kind' | 'body'>[] = [
  { author: 'builder', kind: 'text', body: 'Another project.' },
  { author: 'claude', kind: 'text', body: 'Yes.' },
  { author: 'builder', kind: 'text', body: 'Go on.' },
];

const shapeRows: ShapeRow[] = [];
const taskRows: TaskRow[] = [];
/** An id minted now under a prefix the conversation kinds still read, as the old tables minted them. */
const legacyItem = (prefix: 'shm' | 'tmg') =>
  ConversationItemId.parse(`${prefix}_${idUuid(mintId('ConversationItem'))}`);
const legacyFile = (prefix: 'sfl' | 'tfl') =>
  ConversationFileId.parse(`${prefix}_${idUuid(mintId('ConversationFile'))}`);
const s1Files = { told: legacyFile('sfl'), unreadable: legacyFile('sfl') };
const s3File = legacyFile('sfl');
const t1File = legacyFile('tfl');
const t3File = legacyFile('tfl');
const sessions = {
  s1Old: mintId('Session'),
  s1New: mintId('Session'),
  w1: mintId('Session'),
  w3Old: mintId('Session'),
  w3New: mintId('Session'),
  w2: mintId('Session'),
};

function mintRows(): void {
  // Minted alternately, so the owners' ids interleave and a copy that mixes them shows.
  for (let i = 0; i < S1_LINES.length; i += 1) {
    const line = S1_LINES[i];
    if (line !== undefined)
      shapeRows.push({ id: legacyItem('shm'), shapeId: S1, ...line, createdAt: at(10 + i) });
    const other = S3_LINES[i];
    if (other !== undefined)
      shapeRows.push({ id: legacyItem('shm'), shapeId: S3, ...other, createdAt: at(30 + i) });
  }
  const none = { pushedAt: null, pushUuids: [], deliveredAt: null, turnId: null };
  const message = (taskId: IdOf<'Task'>, minute: number, fields: Partial<TaskRow>): TaskRow => ({
    id: legacyItem('tmg'),
    taskId,
    author: 'builder',
    kind: 'message',
    body: `at ${String(minute)}`,
    createdAt: at(minute),
    ...none,
    ...fields,
  });
  taskRows.push(
    message(T1, 40, { pushedAt: at(40), pushUuids: ['u-1'], deliveredAt: at(41) }),
    message(T3, 50, {}),
    message(T1, 42, { author: 'agent', kind: 'reply', turnId: PT1 }),
    message(T3, 51, { author: 'agent', kind: 'reply' }),
    message(T1, 43, { author: 'system', kind: 'notice' }),
    message(T1, 44, { pushedAt: at(44) }),
  );
}

const ACCOUNT = `INSERT INTO accounts (id, kind, label, payer, settings, lane_cap, created_at, updated_at)
  VALUES (?, 'claude_subscription', ?, '', '{}', 2, ?, ?)`;
const PROJECT = `INSERT INTO projects (id, name, repo_path, gate_command, areas, hazards, max_lanes, provider,
    account_id, handoff_pct, nudge_pct, human_wait_minutes, created_at, updated_at)
  VALUES (?, ?, ?, 'true', '[]', '[]', 2, 'claude', ?, 40, 50, 10, ?, ?)`;
const SHAPE = `INSERT INTO shapes (id, project_id, title, state, origin, sdk_session_id, model, created_at, updated_at)
  VALUES (?, ?, 't', 'open', 'new', ?, ?, ?, ?)`;
const TASK = `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, areas, status, board_order,
    workspace_mode, pass_id, created_at, updated_at)
  VALUES (?, ?, 't', '', '[]', '[]', 'open', 1, 'shared', ?, ?, ?)`;
const WORKSTREAM = `INSERT INTO workstreams (id, task_id, project_id, state, next_action, attempt, recovery_attempts,
    model, effort, fence, created_at, updated_at)
  VALUES (?, ?, ?, 'QUEUED', '{"kind":"start"}', 0, 0, 'sonnet', 'medium', 0, ?, ?)`;
const SESSION = `INSERT INTO sessions (id, workstream_id, shape_id, account_id, sequence, provider, model, effort, mode,
    mcp_token_hash, started_at, input_tokens, output_tokens, created_at, updated_at)
  VALUES (?, ?, ?, ?, 1, 'claude', 'sonnet', 'medium', 'default', ?, ?, 0, 0, ?, ?)`;
const SHAPE_MESSAGE = `INSERT INTO shape_messages (id, shape_id, author, kind, body, created_at)
  VALUES (?, ?, ?, ?, ?, ?)`;
const SHAPE_FILE = `INSERT INTO shape_files (id, shape_id, name, media_type, size, stored_path, told_at, inline_sent,
    unreadable_told_at, created_at)
  VALUES (?, ?, ?, 'image/png', 10, ?, ?, ?, ?, ?)`;
const TASK_MESSAGE = `INSERT INTO task_messages (id, task_id, author, kind, body, created_at, pushed_at, push_uuids,
    delivered_at, turn_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const TASK_FILE = `INSERT INTO task_files (id, task_id, message_id, name, media_type, size, sha256, stored_path,
    inline_sent, created_at)
  VALUES (?, ?, ?, 'p.png', 'image/png', 10, ?, ?, 1, ?)`;

function seed(): void {
  db.$client.pragma('foreign_keys = ON');
  sql(ACCOUNT, A, 'a', at(0), at(0));
  sql(ACCOUNT, B, 'b', at(0), at(0));
  sql(PROJECT, P, 'p', '/tmp/p', A, at(0), at(0));
  sql(PROJECT, P2, 'p2', '/tmp/p2', B, at(0), at(0));
  sql(SHAPE, S1, P, 'sdk-1', 'claude-opus-5-5', at(1), at(9));
  sql(SHAPE, S2, P, null, null, at(2), at(2));
  sql(SHAPE, S3, P2, null, null, at(3), at(3));
  sql(
    `INSERT INTO passes (id, project_id, name, state, return_branch, start_sha, opened_at, created_at, updated_at)
     VALUES (?, ?, 'pass', 'open', 'main', 'abc', ?, ?, ?)`,
    PA,
    P,
    at(4),
    at(4),
    at(4),
  );
  sql(TASK, T1, P, PA, at(5), at(5));
  sql(TASK, T3, P, null, at(6), at(6));
  sql(TASK, T2, P, null, at(7), at(7));
  sql(WORKSTREAM, W1, T1, P, at(5), at(5));
  sql(WORKSTREAM, W3, T3, P, at(6), at(6));
  sql(WORKSTREAM, W2, T2, P, at(7), at(7));
  const session = (
    id: IdOf<'Session'>,
    owner: { ws?: IdOf<'Workstream'>; shape?: IdOf<'Shape'> },
    account: IdOf<'Account'>,
    minute: number,
  ) =>
    sql(
      SESSION,
      id,
      owner.ws ?? null,
      owner.shape ?? null,
      account,
      id,
      at(minute),
      at(minute),
      at(minute),
    );
  session(sessions.s1Old, { shape: S1 }, A, 20);
  session(sessions.s1New, { shape: S1 }, B, 21);
  session(sessions.w1, { ws: W1 }, A, 22);
  session(sessions.w3Old, { ws: W3 }, A, 23);
  session(sessions.w3New, { ws: W3 }, B, 24);
  session(sessions.w2, { ws: W2 }, A, 25);

  for (const m of shapeRows)
    sql(SHAPE_MESSAGE, m.id, m.shapeId, m.author, m.kind, m.body, m.createdAt);
  sql(SHAPE_FILE, s1Files.told, S1, 'told.png', '/f/told.png', at(12), 1, null, at(11));
  sql(SHAPE_FILE, s1Files.unreadable, S1, 'u.heic', '/f/u.heic', null, 0, at(13), at(12));
  sql(SHAPE_FILE, s3File, S3, 'other.png', '/f/other.png', null, 0, null, at(31));
  const s1 = shapeRows.filter((m) => m.shapeId === S1);
  const proposal = mintId('ShapeProposal');
  sql(
    `INSERT INTO shape_proposals (id, shape_id, key, kind, state, round, body, source_message_ids, created_at,
       updated_at)
     VALUES (?, ?, 'k', 'task', 'proposed', 1, '{}', ?, ?, ?)`,
    proposal,
    S1,
    JSON.stringify([s1[0]?.id, s1[2]?.id]),
    at(20),
    at(20),
  );
  sql(
    `INSERT INTO shape_questions (id, shape_id, proposal_id, key, text, for_who, source_message_ids, created_at)
     VALUES (?, ?, ?, 'q', 'Why?', 'builder', ?, ?)`,
    mintId('ShapeQuestion'),
    S1,
    proposal,
    JSON.stringify([s1[1]?.id]),
    at(20),
  );
  sql(
    `INSERT INTO shape_shadow_answers (shape_id, message_id, decision, answer, confidence, judge_call_id,
       created_at)
     VALUES (?, ?, 'shape_ready', 'yes', 0.9, ?, ?)`,
    S1,
    s1[0]?.id,
    mintId('JudgeCall'),
    at(20),
  );

  const [m1, t3a, r1, t3b, n1, m2] = taskRows;
  if ([m1, t3a, r1, t3b, n1, m2].some((m) => m === undefined)) throw new Error('six thread rows');
  const insertTask = (m: TaskRow | undefined) => {
    if (m === undefined) return;
    sql(
      TASK_MESSAGE,
      m.id,
      m.taskId,
      m.author,
      m.kind,
      m.body,
      m.createdAt,
      m.pushedAt,
      JSON.stringify(m.pushUuids),
      m.deliveredAt,
      m.turnId,
    );
  };
  insertTask(m1);
  insertTask(t3a);
  sql(
    `INSERT INTO pass_turns (id, task_id, workstream_id, seq, message_id, started_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    PT1,
    T1,
    W1,
    m1?.id,
    at(41),
    at(41),
    at(41),
  );
  insertTask(r1);
  insertTask(t3b);
  insertTask(n1);
  insertTask(m2);
  sql(TASK_FILE, t1File, T1, m1?.id, 'sha-1', '/t/1.png', at(40));
  sql(TASK_FILE, t3File, T3, t3a?.id, 'sha-3', '/t/3.png', at(50));
  sql(
    `INSERT INTO pass_preview_marks (id, pass_id, task_id, route, turn_id, broken_at, notice_id, created_at,
       updated_at)
     VALUES (?, ?, ?, '/', ?, ?, ?, ?, ?)`,
    mintId('PassPreviewMark'),
    PA,
    T1,
    PT1,
    at(43),
    n1?.id,
    at(43),
    at(43),
  );
}

beforeAll(() => {
  // A space in the path mirrors ~/Library/Application Support/10db.
  dir = mkdtempSync(join(tmpdir(), '10db conversations '));
  db = openDatabase(join(dir, '10db.sqlite'));
  migrateDatabase(db, migrationsBefore(dir, MIGRATION));
  mintRows();
  seed();
  migrateDatabase(db);
  db.$client.pragma('foreign_keys = ON');
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const Conv = z.object({
  id: z.string(),
  project_id: z.string(),
  owner_kind: z.string(),
  owner_id: z.string(),
  profile: z.string(),
  account_id: z.string(),
  model: z.string().nullable(),
  provider_session_id: z.string().nullable(),
  state: z.string().nullable(),
  next_seq: z.number(),
});
const Item = z.object({
  id: z.string(),
  conversation_id: z.string(),
  seq: z.number(),
  author: z.string(),
  kind: z.string(),
  body: z.string().transform((text): unknown => JSON.parse(text)),
  turn_id: z.string().nullable(),
  pushed_at: z.string().nullable(),
  push_uuids: z.string().transform((text): unknown => JSON.parse(text)),
  delivered_at: z.string().nullable(),
  created_at: z.string(),
});
const File = z.object({
  id: z.string(),
  conversation_id: z.string(),
  item_id: z.string().nullable(),
  sha256: z.string().nullable(),
  inline_sent: z.number(),
  told_at: z.string().nullable(),
  unreadable_told_at: z.string().nullable(),
});

const itemsOf = (conversation: string) =>
  rows(
    Item,
    'SELECT * FROM conversation_items WHERE conversation_id = ? ORDER BY seq',
    conversation,
  );

describe('migration 0076, the conversation copy', () => {
  it('makes one conversation per shape and per task with a thread, under its owner’s uuid', () => {
    const fields =
      'id, project_id, owner_kind, owner_id, profile, account_id, model, provider_session_id, state, next_seq';
    expect
      .soft(rows(Conv, `SELECT ${fields} FROM conversations ORDER BY owner_kind, created_at`))
      .toEqual([
        {
          id: cnv(S1),
          project_id: P,
          owner_kind: 'shape',
          owner_id: S1,
          profile: 'explore',
          account_id: B,
          model: 'claude-opus-5-5',
          provider_session_id: 'sdk-1',
          state: 'idle_cold',
          next_seq: 13,
        },
        {
          id: cnv(S2),
          project_id: P,
          owner_kind: 'shape',
          owner_id: S2,
          profile: 'explore',
          account_id: A,
          model: null,
          provider_session_id: null,
          state: 'idle_cold',
          next_seq: 1,
        },
        {
          id: cnv(S3),
          project_id: P2,
          owner_kind: 'shape',
          owner_id: S3,
          profile: 'explore',
          account_id: B,
          model: null,
          provider_session_id: null,
          state: 'idle_cold',
          next_seq: 4,
        },
        {
          id: cnv(T1),
          project_id: P,
          owner_kind: 'task',
          owner_id: T1,
          profile: 'lane',
          account_id: A,
          model: null,
          provider_session_id: null,
          state: null,
          next_seq: 5,
        },
        {
          id: cnv(T3),
          project_id: P,
          owner_kind: 'task',
          owner_id: T3,
          profile: 'lane',
          account_id: B,
          model: null,
          provider_session_id: null,
          state: null,
          next_seq: 3,
        },
      ]);
  });

  it('gives each conversation exactly its owner’s rows, numbered 1…n in their old order, each Plan row as shapeItemOf and each thread row as taskItemOf maps it', () => {
    const owned = (owner: IdOf<'Shape'> | IdOf<'Task'>) => [
      ...shapeRows.filter((m) => m.shapeId === owner).map((m) => m.id),
      ...taskRows.filter((m) => m.taskId === owner).map((m) => m.id),
    ];
    for (const owner of [S1, S3, T1, T3]) {
      const items = itemsOf(cnv(owner));
      expect
        .soft(
          items.map((i) => i.id),
          owner,
        )
        .toEqual(owned(owner));
      expect
        .soft(
          items.map((i) => i.seq),
          owner,
        )
        .toEqual(owned(owner).map((_, n) => n + 1));
    }
    expect.soft(itemsOf(cnv(S2))).toEqual([]);
    expect
      .soft(column('SELECT count(*) FROM conversation_items'))
      .toEqual([shapeRows.length + taskRows.length]);
    // A Plan row as shapeItemOf maps it, and a builder message as delivered at its time.
    const copied = new Map(
      itemsOf(cnv(S1))
        .concat(itemsOf(cnv(S3)))
        .map((i) => [i.id, i]),
    );
    for (const m of shapeRows) {
      const item = copied.get(m.id);
      const label = `${m.author}/${m.kind}: ${m.body.slice(0, 40)}`;
      expect.soft(item, label).toMatchObject({ ...shapeItemOf(m, m.id), created_at: m.createdAt });
      expect
        .soft(item?.delivered_at, label)
        .toBe(m.author === 'builder' && m.kind === 'text' ? m.createdAt : null);
      expect.soft(item, label).toMatchObject({ turn_id: null, pushed_at: null, push_uuids: [] });
    }
    expect
      .soft(itemsOf(cnv(S1)).map((i) => `${i.author}/${i.kind}`))
      .toEqual([
        'builder/message',
        'agent/agent_message',
        'agent/tool_call',
        'system/notice',
        'system/digest',
        'system/shape_event',
        'system/shape_event',
        'system/shape_event',
        'system/shape_event',
        'agent/shape_event',
        'agent/tool_call',
        'agent/tool_call',
      ]);
    const tools = itemsOf(cnv(S1)).filter((i) => i.kind === 'tool_call');
    const views = tools.map((i) => ToolCallView.parse(i.body));
    expect.soft(views.map((v) => [v.kind, v.harnessTool])).toEqual([
      ['other', '10db.plan'],
      ['other', '10db.plan'],
      ['other', '10db.plan'],
    ]);
    expect.soft(views[1]?.title).toHaveLength(300);
    expect.soft(views[2]).toMatchObject({ inputPreview: '🙂'.repeat(100) });
    // A thread row as taskItemOf maps it, keeping its turn and delivery.
    const thread = new Map(
      itemsOf(cnv(T1))
        .concat(itemsOf(cnv(T3)))
        .map((i) => [i.id, i]),
    );
    for (const m of taskRows)
      expect.soft({ ...thread.get(m.id), seq: 0 }, `${m.author}/${m.kind}: ${m.body}`).toEqual({
        id: m.id,
        conversation_id: cnv(m.taskId),
        seq: 0,
        ...taskItemOf(m),
        turn_id: m.turnId,
        pushed_at: m.pushedAt,
        push_uuids: m.pushUuids,
        delivered_at: m.deliveredAt,
        created_at: m.createdAt,
      });
    expect.soft(thread.get(taskRows[2]?.id ?? '')).toMatchObject({
      kind: 'agent_message',
      turn_id: PT1,
    });
  });

  it('keeps each file’s id, conversation and marks, names each session’s conversation, and leaves every reference to a message naming an item', () => {
    expect.soft(rows(File, 'SELECT * FROM conversation_files ORDER BY created_at, id')).toEqual([
      {
        id: s1Files.told,
        conversation_id: cnv(S1),
        item_id: null,
        sha256: null,
        inline_sent: 1,
        told_at: at(12),
        unreadable_told_at: null,
      },
      {
        id: s1Files.unreadable,
        conversation_id: cnv(S1),
        item_id: null,
        sha256: null,
        inline_sent: 0,
        told_at: null,
        unreadable_told_at: at(13),
      },
      {
        id: s3File,
        conversation_id: cnv(S3),
        item_id: null,
        sha256: null,
        inline_sent: 0,
        told_at: null,
        unreadable_told_at: null,
      },
      {
        id: t1File,
        conversation_id: cnv(T1),
        item_id: taskRows[0]?.id,
        sha256: 'sha-1',
        inline_sent: 1,
        told_at: null,
        unreadable_told_at: null,
      },
      {
        id: t3File,
        conversation_id: cnv(T3),
        item_id: taskRows[1]?.id,
        sha256: 'sha-3',
        inline_sent: 1,
        told_at: null,
        unreadable_told_at: null,
      },
    ]);
    const of = (id: IdOf<'Session'>) =>
      column('SELECT conversation_id FROM sessions WHERE id = ?', id)[0];
    expect.soft(of(sessions.s1Old)).toBe(cnv(S1));
    expect.soft(of(sessions.s1New)).toBe(cnv(S1));
    expect.soft(of(sessions.w1)).toBe(cnv(T1));
    expect.soft(of(sessions.w3Old)).toBe(cnv(T3));
    expect.soft(of(sessions.w3New)).toBe(cnv(T3));
    expect.soft(of(sessions.w2)).toBeNull();
    const items = new Set(itemsOf(cnv(S1)).map((i) => i.id));
    const listed = [
      ...column(
        'SELECT j.value FROM shape_proposals p, json_each(p.source_message_ids) j WHERE p.shape_id = ?',
        S1,
      ),
      ...column(
        'SELECT j.value FROM shape_questions q, json_each(q.source_message_ids) j WHERE q.shape_id = ?',
        S1,
      ),
    ];
    expect.soft(listed).toHaveLength(3);
    for (const id of listed) expect.soft(items.has(String(id))).toBe(true);
    const named = [
      ...column('SELECT message_id FROM shape_shadow_answers'),
      ...column('SELECT message_id FROM pass_turns'),
      ...column('SELECT notice_id FROM pass_preview_marks'),
    ];
    expect.soft(named).toHaveLength(3);
    for (const id of named)
      expect.soft(column('SELECT count(*) FROM conversation_items WHERE id = ?', id)).toEqual([1]);
  });

  it('leaves sessions naming their conversation, shapes without a session or model of their own, a turn’s message and a preview mark’s notice declared as items, and the replaced tables dropped with no dangling reference', () => {
    const columns = (table: string) => column('SELECT name FROM pragma_table_info(?)', table);
    expect.soft(columns('sessions')).not.toContain('shape_id');
    expect.soft(columns('sessions')).toContain('conversation_id');
    expect.soft(columns('shapes')).not.toContain('sdk_session_id');
    expect.soft(columns('shapes')).not.toContain('model');
    const target = (table: string, from: string) =>
      rows(
        z.object({ from: z.string(), table: z.string() }),
        'SELECT "from", "table" FROM pragma_foreign_key_list(?)',
        table,
      ).find((fk) => fk.from === from)?.table;
    expect.soft(target('pass_turns', 'message_id')).toBe('conversation_items');
    expect.soft(target('pass_preview_marks', 'notice_id')).toBe('conversation_items');
    expect
      .soft(
        column(
          `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name IN ('shape_messages', 'shape_files', 'task_messages', 'task_files')`,
        ),
      )
      .toEqual([]);
    expect.soft(db.$client.pragma('foreign_key_check')).toEqual([]);
  });
});
