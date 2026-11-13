import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase, schema, type TendbDatabase } from './index';

let dir: string;
let db: TendbDatabase;
const now = '2026-10-13T12:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '10db-schema-'));
  db = openDatabase(join(dir, 'db.sqlite'));
  migrateDatabase(db);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedProjectAndWorkstreams() {
  const accountId = mintId('Account');
  db.insert(schema.accounts)
    .values({
      id: accountId,
      kind: 'claude_subscription',
      label: 'a',
      payer: '',
      settings: {},
      laneCap: 4,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const projectId = mintId('Project');
  db.insert(schema.projects)
    .values({
      id: projectId,
      name: 'p',
      repoPath: '/tmp/p',
      gateCommand: 'true',
      areas: [{ name: 'src', globs: ['src/**'] }],
      hazards: [],
      maxLanes: 2,
      provider: 'claude',
      accountId,
      handoffPct: 40,
      nudgePct: 50,
      humanWaitMinutes: 10,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const taskId = mintId('Task');
  db.insert(schema.tasks)
    .values({
      id: taskId,
      projectId,
      title: 't',
      description: '',
      acceptanceCriteria: ['a'],
      areas: ['src'],
      status: 'open',
      boardOrder: 1,
      workspaceMode: 'shared',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const ws = () => {
    const id = mintId('Workstream');
    db.insert(schema.workstreams)
      .values({
        id,
        taskId,
        projectId,
        state: 'QUEUED',
        nextAction: { kind: 'start' },
        attempt: 0,
        recoveryAttempts: 0,
        model: 'sonnet',
        effort: 'medium',
        fence: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  };
  return { accountId, projectId, ws1: ws(), ws2: ws() };
}

function columnNames(table: string): unknown[] {
  return db.$client.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table);
}

function indexNames(table: string): unknown[] {
  return db.$client.prepare('SELECT name FROM pragma_index_list(?)').pluck().all(table);
}

describe('schema', () => {
  it('allows only one active claim per project, kind and name', () => {
    const { projectId, ws1, ws2 } = seedProjectAndWorkstreams();
    const claim = (workstreamId: typeof ws1) => ({
      id: mintId('Claim'),
      projectId,
      workstreamId,
      kind: 'area' as const,
      name: 'src',
      exclusive: true,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const first = claim(ws1);
    db.insert(schema.claims).values(first).run();
    expect(() => db.insert(schema.claims).values(claim(ws2)).run()).toThrow(/UNIQUE/);

    db.update(schema.claims).set({ releasedAt: now }).run();
    expect(() => db.insert(schema.claims).values(claim(ws2)).run()).not.toThrow();
  });

  it('indexes decisions for full-text search through triggers', () => {
    const { projectId } = seedProjectAndWorkstreams();
    const sourceId = mintId('Source');
    db.insert(schema.sources)
      .values({ id: sourceId, kind: 'builder', ref: {}, createdAt: now })
      .run();
    db.insert(schema.decisions)
      .values({
        id: mintId('Decision'),
        projectId,
        question: 'Which queue library?',
        choice: 'BullMQ',
        rationale: 'Redis is already deployed',
        decidedBy: 'me',
        scope: 'project',
        sourceId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const hits = db.$client
      .prepare("SELECT choice FROM decisions_fts WHERE decisions_fts MATCH 'queue'")
      .all();
    expect(hits).toEqual([{ choice: 'BullMQ' }]);
  });

  it('indexes principles by statement, topic key and quote, and follows edits and deletes', () => {
    const { projectId } = seedProjectAndWorkstreams();
    const sourceId = mintId('Source');
    db.insert(schema.sources)
      .values({ id: sourceId, kind: 'builder', ref: {}, createdAt: now })
      .run();
    const id = mintId('Principle');
    db.insert(schema.principles)
      .values({
        id,
        projectId,
        scope: 'project',
        area: null,
        statement: 'Never sleep in tests',
        rationale: 'Sleeps make a suite slow and flaky',
        kind: 'policy',
        topicKey: 'testing.no-sleeps',
        status: 'confirmed',
        sourceId,
        sourceQuote: 'wait on a condition instead',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const match = (term: string) =>
      db.$client
        .prepare('SELECT statement FROM principles_fts WHERE principles_fts MATCH ?')
        .all(term);
    expect(match('sleep')).toEqual([{ statement: 'Never sleep in tests' }]);
    expect(match('condition')).toEqual([{ statement: 'Never sleep in tests' }]);
    expect(match('testing')).toEqual([{ statement: 'Never sleep in tests' }]);

    db.update(schema.principles).set({ statement: 'Never poll in tests' }).run();
    expect(match('sleep')).toEqual([]);
    expect(match('poll')).toEqual([{ statement: 'Never poll in tests' }]);

    db.delete(schema.principles).run();
    expect(match('poll')).toEqual([]);
  });

  it('gives principles their own columns, with the same tombstone decisions carry', () => {
    expect(columnNames('principles')).toEqual(
      expect.arrayContaining([
        'project_id',
        'scope',
        'area',
        'statement',
        'rationale',
        'kind',
        'topic_key',
        'status',
        'supersedes_id',
        'source_id',
        'source_quote',
        'speaker',
        'confirmed_by',
        'confirmed_at',
        'retired_at',
        'retired_by',
        'retired_reason',
        'withdrawn_at',
        'withdrawn_by',
        'withdrawn_reason',
      ]),
    );
    expect(columnNames('proposals')).toContain('principle_id');
  });

  it.each([
    ['decisions', 'decisions_supersedes_idx'],
    ['principles', 'principles_supersedes_idx'],
    ['principles', 'principles_topic_idx'],
  ])('indexes %s with %s, which every successor and key lookup reads', (table, index) => {
    expect(indexNames(table)).toContain(index);
  });

  it('numbers events monotonically', () => {
    const insert = () =>
      db
        .insert(schema.events)
        .values({ type: 'task.created', entityType: 'task', entityId: 'x', data: {}, at: now })
        .returning()
        .get();
    expect(insert().seq).toBe(1);
    expect(insert().seq).toBe(2);
  });

  it.each([
    ['sessions', ['created_at', 'updated_at']],
    ['claims', ['created_at', 'updated_at']],
    ['permission_rules', ['created_at', 'updated_at']],
    ['principles', ['created_at', 'updated_at']],
  ])('gives mutable table %s its timestamp columns', (table, expected) => {
    expect(columnNames(table)).toEqual(expect.arrayContaining(expected));
  });

  it.each(['events', 'tool_ops', 'evidence', 'handoffs', 'sources'])(
    'keeps append-only table %s free of updated_at',
    (table) => {
      const columns = columnNames(table);
      expect(columns).not.toHaveLength(0);
      expect(columns).not.toContain('updated_at');
    },
  );
});

describe('the conversation tables', () => {
  function seedConversation() {
    const { accountId, projectId } = seedProjectAndWorkstreams();
    const id = mintId('Conversation');
    const owner = { ownerKind: 'shape', ownerId: mintId('Shape') } as const;
    const values = {
      projectId,
      ...owner,
      profile: 'explore',
      accountId,
      state: 'idle_cold',
      createdAt: now,
      updatedAt: now,
    } as const;
    db.insert(schema.conversations)
      .values({ id, ...values })
      .run();
    return { id, values, accountId };
  }
  const item = (conversationId: ReturnType<typeof mintId<'Conversation'>>, seq: number) => ({
    id: mintId('ConversationItem'),
    conversationId,
    seq,
    author: 'builder' as const,
    kind: 'message' as const,
    body: { text: 'hi' },
    createdAt: now,
    updatedAt: now,
  });

  it('numbers items uniquely within a conversation', () => {
    const { id } = seedConversation();
    db.insert(schema.conversationItems).values(item(id, 1)).run();
    expect(() => db.insert(schema.conversationItems).values(item(id, 1)).run()).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('gives an owner one conversation', () => {
    const { values } = seedConversation();
    expect(() =>
      db
        .insert(schema.conversations)
        .values({ id: mintId('Conversation'), ...values })
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('lets a session name its conversation, and still refuses a session with no owner', () => {
    const { accountId } = seedConversation();
    expect(columnNames('sessions')).toContain('conversation_id');
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO sessions (id, account_id, sequence, provider, model, effort, mode, mcp_token_hash,
             started_at, input_tokens, output_tokens, created_at, updated_at)
           VALUES (?, ?, 1, 'claude', 'm', 'medium', 'default', 'h', ?, 0, 0, ?, ?)`,
        )
        .run(mintId('Session'), accountId, now, now, now),
    ).toThrow(/CHECK constraint failed: sessions_one_owner/);
  });
});
