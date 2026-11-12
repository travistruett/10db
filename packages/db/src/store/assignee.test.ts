import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventType, RoutedBy } from '@10db/contracts';
import { getInboxItem, insertInboxItem, setInboxRecipients } from './inbox';
import { assigneeFor, setRoutingRules } from './routing-rules';
import type { Store } from './store';
import { insertTask } from './tasks';
import { insertPerson } from './team';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

function setup() {
  const project = seedProject(store); // areas api, ui
  const sam = store.write((ctx) => insertPerson(ctx, { handle: 'sam', name: 'Sam' })).value;
  const ana = store.write((ctx) => insertPerson(ctx, { handle: 'ana', name: 'Ana' })).value;
  store.write((ctx) =>
    setRoutingRules(ctx, project.id, {
      rules: [
        { category: 'design', area: null, personId: sam.id },
        { category: 'design', area: 'ui', personId: ana.id },
      ],
    }),
  );
  return project;
}

describe('assigneeFor', () => {
  it.each([
    { name: 'the area rule over the category rule', category: 'design', areas: ['ui'], who: 'ana' },
    {
      name: 'the category rule when no area rule matches',
      category: 'design',
      areas: ['api'],
      who: 'sam',
    },
    {
      name: 'the category rule when the work claims no area',
      category: 'design',
      areas: [],
      who: 'sam',
    },
    {
      name: 'the builder when no rule covers the category',
      category: 'engineering',
      areas: ['ui'],
      who: 'me',
    },
  ] as const)('picks $name', ({ category, areas, who }) => {
    const project = setup();
    expect(assigneeFor(store.db, project.id, category, areas)).toBe(who);
  });

  it("gives a new card the owner its workstream's areas route to", () => {
    const project = setup();
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'T', acceptanceCriteria: ['x'], areas: ['ui'] }),
    ).value;
    const ws = store.write((ctx) =>
      insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    ).value;
    const card = store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: project.id,
        kind: 'question',
        title: 'Which shade?',
        body: '',
        options: [],
        recommendation: null,
        category: 'design',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [{ workstreamId: ws.id, sessionId: null }],
      }),
    ).value;
    expect(card.assignee).toBe('ana');
  });
});

describe('setInboxRecipients', () => {
  const newCard = (project: ReturnType<typeof setup>) =>
    store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: project.id,
        kind: 'question',
        title: 'Which?',
        body: '',
        options: [],
        recommendation: null,
        category: 'engineering',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [],
      }),
    ).value;

  it('sets the first handle as the assignee, keeps the list and the suggestion', () => {
    const card = newCard(setup());
    const ana = store.write((ctx) => insertPerson(ctx, { handle: 'zed', name: 'Zed' })).value;
    store.write((ctx) =>
      setInboxRecipients(ctx, card.id, {
        assignees: ['sam', 'ana'],
        routedBy: RoutedBy.Judge,
        suggestion: { personIds: [ana.id], confidence: 0.7 },
      }),
    );
    expect(getInboxItem(store.db, card.id)).toMatchObject({
      assignee: 'sam',
      assignees: ['sam', 'ana'],
      routedBy: 'judge',
      routeSuggestion: { personIds: [ana.id], confidence: 0.7 },
    });
  });

  it('falls to the builder when the list is empty, and announces leaving triage_pending once', () => {
    const card = newCard(setup());
    store.write((ctx) =>
      setInboxRecipients(ctx, card.id, {
        assignees: ['sam'],
        routedBy: RoutedBy.TriagePending,
        suggestion: null,
      }),
    );
    const first = store.write((ctx) =>
      setInboxRecipients(ctx, card.id, {
        assignees: [],
        routedBy: RoutedBy.Builder,
        suggestion: null,
      }),
    );
    expect(first.value.assignee).toBe('me');
    expect(first.events.find((e) => e.type === EventType.InboxTriaged)?.data).toEqual({
      routedBy: 'builder',
      toBuilder: true,
    });
    const second = store.write((ctx) =>
      setInboxRecipients(ctx, card.id, {
        assignees: ['sam'],
        routedBy: RoutedBy.Rule,
        suggestion: null,
      }),
    );
    expect(second.events.some((e) => e.type === EventType.InboxTriaged)).toBe(false);
  });
});
