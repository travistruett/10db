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
      billingMode: 'subscription',
      model: 'sonnet',
      effort: 'medium',
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
  return { projectId, ws1: ws(), ws2: ws() };
}

function columnNames(table: string): string[] {
  const rows = db.$client.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]; // PRAGMA output shape is fixed by SQLite
  return rows.map((row) => row.name);
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
  ])('gives mutable table %s its timestamp columns', (table, expected) => {
    expect(columnNames(table)).toEqual(expect.arrayContaining(expected));
  });

  it.each(['events', 'tool_ops', 'evidence', 'handoffs'])(
    'keeps append-only table %s free of updated_at',
    (table) => {
      expect(columnNames(table)).not.toContain('updated_at');
    },
  );
});
