import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findOpenByFoldKey,
  getInboxItem,
  hasAnsweredByFoldKey,
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

  it.each([
    { state: 'OPEN', answered: false },
    { state: 'ANSWERED', answered: true },
    { state: 'DELIVERING', answered: true },
    { state: 'RESOLVED', answered: true },
    { state: 'CANCELLED', answered: false },
    { state: 'EXPIRED', answered: false },
  ] as const)(
    'counts a $state card with the fold key as answered: $answered',
    ({ state, answered }) => {
      const project = seedProject(store);
      expect(hasAnsweredByFoldKey(store.db, project.id, 'fold-1')).toBe(false);
      const item = store.write((ctx) => insertInboxItem(ctx, question(project.id))).value;
      store.write((ctx) => updateInboxItem(ctx, item.id, { state }));
      expect(hasAnsweredByFoldKey(store.db, project.id, 'fold-1')).toBe(answered);
      expect(hasAnsweredByFoldKey(store.db, project.id, 'fold-2')).toBe(false);
      expect(hasAnsweredByFoldKey(store.db, seedProject(store).id, 'fold-1')).toBe(false);
    },
  );

  it.each([
    { state: 'OPEN', included: true },
    { state: 'ANSWERED', included: true },
    { state: 'DELIVERING', included: true },
    { state: 'RESOLVED', included: false },
    { state: 'CANCELLED', included: false },
    { state: 'EXPIRED', included: false },
  ] as const)(
    'targeting lookup for a $state card includes it: $included',
    ({ state, included }) => {
      const project = seedProject(store);
      const target = mintId('Workstream');
      const item = store.write((ctx) =>
        insertInboxItem(
          ctx,
          question(project.id, { targets: [{ workstreamId: target, sessionId: null }] }),
        ),
      ).value;
      store.write((ctx) => updateInboxItem(ctx, item.id, { state }));
      expect(openItemsForWorkstream(store.db, target).map((i) => i.id)).toEqual(
        included ? [item.id] : [],
      );
    },
  );

  it('finds only the cards that target the workstream', () => {
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

  it('returns a card that targets two workstreams for both', () => {
    const project = seedProject(store);
    const w1 = mintId('Workstream');
    const w2 = mintId('Workstream');
    const item = store.write((ctx) =>
      insertInboxItem(
        ctx,
        question(project.id, {
          targets: [
            { workstreamId: w1, sessionId: null },
            { workstreamId: w2, sessionId: null },
          ],
        }),
      ),
    ).value;
    expect(openItemsForWorkstream(store.db, w1).map((i) => i.id)).toEqual([item.id]);
    expect(openItemsForWorkstream(store.db, w2).map((i) => i.id)).toEqual([item.id]);
  });

  it('breaks urgency and age ties by id on a fixed clock', () => {
    close();
    ({ store, close } = createTestStore(() => new Date('2026-01-01T00:00:00.000Z')));
    const project = seedProject(store);
    const ids = ['a', 'b', 'c'].map(
      (foldKey) =>
        store.write((ctx) => insertInboxItem(ctx, question(project.id, { foldKey }))).value.id,
    );
    // Push the smallest id to the end of the table's scan order.
    store.db.$client
      .prepare('UPDATE inbox_items SET rowid = rowid + 1000 WHERE id = ?')
      .run(ids[0]);
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

  it('rewrites an open card title, body and detail, keeping its id and fold key', () => {
    const project = seedProject(store);
    const item = store.write((ctx) => insertInboxItem(ctx, question(project.id))).value;
    const { events } = store.write((ctx) => {
      updateInboxItem(ctx, item.id, {
        title: 'Which shade?',
        body: 'Pick again',
        detail: { n: 2 },
      });
    });
    expect(findOpenByFoldKey(store.db, project.id, 'fold-1')).toMatchObject({
      id: item.id,
      title: 'Which shade?',
      body: 'Pick again',
      detail: { n: 2 },
    });
    expect(events.map((e) => e.type)).toEqual(['inbox.changed']);
  });

  it('rejects an update to a missing item', () => {
    expect(() =>
      store.write((ctx) => updateInboxItem(ctx, mintId('InboxItem'), { state: 'CANCELLED' })),
    ).toThrow(/not found|inbox item/i);
  });

  it('lists only the most recently updated items, newest first, when asked for the recent ones', () => {
    let tick = 0;
    close();
    ({ store, close } = createTestStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))));
    const project = seedProject(store);
    const ids = ['a', 'b', 'c'].map(
      (foldKey) =>
        store.write((ctx) => insertInboxItem(ctx, question(project.id, { foldKey }))).value.id,
    );
    // The oldest is updated last, so it is the newest now.
    store.write((ctx) => {
      updateInboxItem(ctx, ids[0] ?? mintId('InboxItem'), { state: 'RESOLVED' });
    });
    expect(listInbox(store.db, { recent: 2 }).map((i) => i.id)).toEqual([ids[0], ids[2]]);
    expect(listInbox(store.db, { states: ['OPEN'], recent: 5 }).map((i) => i.id)).toEqual([
      ids[2],
      ids[1],
    ]);
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
  type Scope = 'mine' | 'other';
  const rows: {
    name: string;
    rules: { project: Scope; workstream: 'ws' | 'otherWs' | null; tool: string }[];
    expected: string[];
  }[] = [
    { name: 'no rules', rules: [], expected: [] },
    {
      name: "another project's project-wide rule is excluded",
      rules: [{ project: 'other', workstream: null, tool: 'Foreign' }],
      expected: [],
    },
    {
      name: "another project's rule for the same workstream id is excluded",
      rules: [{ project: 'other', workstream: 'ws', tool: 'Foreign' }],
      expected: [],
    },
    {
      name: "this project's project-wide rule is included",
      rules: [{ project: 'mine', workstream: null, tool: 'Bash' }],
      expected: ['Bash'],
    },
    {
      name: "this workstream's rule is included",
      rules: [{ project: 'mine', workstream: 'ws', tool: 'WebFetch' }],
      expected: ['WebFetch'],
    },
    {
      name: "another workstream's rule is excluded",
      rules: [{ project: 'mine', workstream: 'otherWs', tool: 'WebSearch' }],
      expected: [],
    },
  ];

  it.each(rows)('$name', ({ rules, expected }) => {
    const mine = seedProject(store);
    const other = seedProject(store);
    const ids = { ws: mintId('Workstream'), otherWs: mintId('Workstream') };
    store.write((ctx) => {
      for (const r of rules) {
        insertPermissionRule(ctx, {
          projectId: r.project === 'mine' ? mine.id : other.id,
          workstreamId: r.workstream === null ? null : ids[r.workstream],
          toolName: r.tool,
          pattern: null,
          sourceInboxId: null,
        });
      }
    });
    expect(
      listPermissionRules(store.db, mine.id, ids.ws)
        .map((r) => r.toolName)
        .sort(),
    ).toEqual(expected);
  });

  it("lists only the project-wide rules when no workstream is named, as a batch's gate needs", () => {
    const mine = seedProject(store);
    const other = seedProject(store);
    store.write((ctx) => {
      for (const [projectId, workstreamId, toolName] of [
        [mine.id, null, 'SandboxNetworkAccess'],
        [mine.id, mintId('Workstream'), 'WebFetch'],
        [other.id, null, 'Bash'],
      ] as const) {
        insertPermissionRule(ctx, {
          projectId,
          workstreamId,
          toolName,
          pattern: null,
          sourceInboxId: null,
        });
      }
    });
    expect(listPermissionRules(store.db, mine.id, null).map((r) => r.toolName)).toEqual([
      'SandboxNetworkAccess',
    ]);
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
