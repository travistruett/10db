import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findOpenByFoldKey,
  getInboxItem,
  insertInboxItem,
  listInbox,
  openItemsForWorkstream,
  updateInboxItem,
} from './inbox';
import {
  getProposal,
  insertDecision,
  insertProposal,
  insertSource,
  listRecentDecisions,
  resolveProposal,
  searchDecisions,
} from './knowledge';
import { insertPermissionRule, listPermissionRules } from './permission-rules';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

const question = (
  projectId: ReturnType<typeof seedProject>['id'],
  overrides: Partial<Parameters<typeof insertInboxItem>[1]> = {},
) => ({
  projectId,
  kind: 'question' as const,
  title: 'Which color?',
  body: 'Pick one',
  options: [
    { label: 'Teal', description: '' },
    { label: 'Red', description: '' },
  ],
  recommendation: null,
  category: 'design' as const,
  urgency: 'normal' as const,
  detail: null,
  foldKey: 'fold-1',
  targets: [{ workstreamId: mintId('Workstream'), sessionId: null }],
  ...overrides,
});

describe('inbox', () => {
  it('finds an open item by fold key and stops finding it once answered', () => {
    const project = seedProject(store);
    const item = store.write((ctx) => insertInboxItem(ctx, question(project.id))).value;
    expect(findOpenByFoldKey(store.db, project.id, 'fold-1')?.id).toBe(item.id);
    store.write((ctx) =>
      updateInboxItem(ctx, item.id, { state: 'ANSWERED', answer: { choice: 'Teal' } }),
    );
    expect(findOpenByFoldKey(store.db, project.id, 'fold-1')).toBeUndefined();
  });

  it('finds items targeting a workstream', () => {
    const project = seedProject(store);
    const target = mintId('Workstream');
    store.write((ctx) =>
      insertInboxItem(
        ctx,
        question(project.id, { targets: [{ workstreamId: target, sessionId: null }] }),
      ),
    );
    store.write((ctx) => insertInboxItem(ctx, question(project.id, { foldKey: 'fold-2' })));
    expect(openItemsForWorkstream(store.db, target)).toHaveLength(1);
  });

  it('breaks urgency and age ties by id on a fixed clock', () => {
    close();
    ({ store, close } = createTestStore(() => new Date('2026-01-01T00:00:00.000Z')));
    const project = seedProject(store);
    const ids = ['a', 'b', 'c'].map(
      (foldKey) =>
        store.write((ctx) => insertInboxItem(ctx, question(project.id, { foldKey }))).value.id,
    );
    expect(listInbox(store.db).map((i) => i.id)).toEqual(ids);
  });

  it('records an answer, bumps updated_at and emits inbox.changed', () => {
    let tick = 0;
    close();
    ({ store, close } = createTestStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))));
    const project = seedProject(store);
    const item = store.write((ctx) => insertInboxItem(ctx, question(project.id))).value;
    const { events } = store.write((ctx) => {
      updateInboxItem(ctx, item.id, { state: 'ANSWERED', answer: { choice: 'Red' } });
    });
    const after = getInboxItem(store.db, item.id);
    expect(after).toMatchObject({ state: 'ANSWERED', answer: { choice: 'Red' } });
    expect(after.updatedAt > item.updatedAt).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['inbox.changed']);
  });

  it('rejects an update to a missing item', () => {
    expect(() =>
      store.write((ctx) => updateInboxItem(ctx, mintId('InboxItem'), { state: 'CANCELLED' })),
    ).toThrow(/not found|inbox item/i);
  });

  it('sorts high urgency first', () => {
    const project = seedProject(store);
    store.write((ctx) =>
      insertInboxItem(ctx, question(project.id, { title: 'normal', foldKey: 'a' })),
    );
    store.write((ctx) =>
      insertInboxItem(ctx, question(project.id, { title: 'high', urgency: 'high', foldKey: 'b' })),
    );
    expect(listInbox(store.db, { states: ['OPEN'] }).map((i) => i.title)).toEqual([
      'high',
      'normal',
    ]);
  });
});

describe('permission rules', () => {
  it('returns project rules plus the workstream rules, not other workstreams', () => {
    const project = seedProject(store);
    const mine = mintId('Workstream');
    const other = mintId('Workstream');
    store.write((ctx) => {
      insertPermissionRule(ctx, {
        projectId: project.id,
        workstreamId: null,
        toolName: 'Bash',
        pattern: 'docker compose',
        sourceInboxId: null,
      });
      insertPermissionRule(ctx, {
        projectId: project.id,
        workstreamId: mine,
        toolName: 'WebFetch',
        pattern: null,
        sourceInboxId: null,
      });
      insertPermissionRule(ctx, {
        projectId: project.id,
        workstreamId: other,
        toolName: 'WebSearch',
        pattern: null,
        sourceInboxId: null,
      });
    });
    expect(
      listPermissionRules(store.db, project.id, mine)
        .map((r) => r.toolName)
        .sort(),
    ).toEqual(['Bash', 'WebFetch']);
  });
});

describe('knowledge', () => {
  function record(
    projectId: ReturnType<typeof seedProject>['id'] | null,
    q: string,
    choice: string,
  ) {
    return store.write((ctx) => {
      const sourceId = insertSource(ctx, 'builder', { note: 'test' });
      return insertDecision(ctx, {
        projectId,
        question: q,
        choice,
        rationale: 'because',
        decidedBy: 'me',
        scope: projectId ? 'project' : 'you',
        area: null,
        sourceId,
      });
    }).value;
  }

  it('reads every write back through search', () => {
    const project = seedProject(store);
    const id = record(project.id, 'Which queue library?', 'BullMQ');
    expect(searchDecisions(store.db, project.id, 'queue', 5).map((h) => h.id)).toEqual([id]);
  });

  it('includes decisions scoped to you in every project', () => {
    const p1 = seedProject(store);
    const p2 = seedProject(store);
    record(null, 'Preferred commit style?', 'Imperative mood');
    record(p1.id, 'Commit hooks?', 'None');
    expect(searchDecisions(store.db, p2.id, 'commit', 5).map((h) => h.choice)).toEqual([
      'Imperative mood',
    ]);
  });

  it('treats search text as data, not FTS syntax', () => {
    const project = seedProject(store);
    record(project.id, "What's the deal with quotes?", 'Escape them');
    expect(() =>
      searchDecisions(store.db, project.id, `what's -the "deal" (NEAR OR`, 5),
    ).not.toThrow();
    expect(searchDecisions(store.db, project.id, `what's "deal"`, 5)).toHaveLength(1);
    expect(searchDecisions(store.db, project.id, '***', 5)).toEqual([]);
  });

  it('lists recent decisions newest first', () => {
    const project = seedProject(store);
    record(project.id, 'first?', 'a');
    record(project.id, 'second?', 'b');
    expect(listRecentDecisions(store.db, project.id, 1).map((d) => d.question)).toEqual([
      'second?',
    ]);
  });

  it('records a verdict and its rationale on a proposal', () => {
    const project = seedProject(store);
    const id = store.write((ctx) => {
      const sourceId = insertSource(ctx, 'agent', {});
      return insertProposal(ctx, {
        projectId: project.id,
        kind: 'new_task',
        title: 'Add caching',
        body: 'b',
        sourceId,
      });
    }).value;
    expect(getProposal(store.db, id).status).toBe('pending');
    const { events } = store.write((ctx) => {
      resolveProposal(ctx, id, { status: 'rejected', rationale: 'not now' });
    });
    expect(getProposal(store.db, id)).toMatchObject({ status: 'rejected', rationale: 'not now' });
    expect(events.map((e) => e.type)).toEqual(['proposal.resolved']);
  });
});
