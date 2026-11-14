import { ConflictError, EventType, InvalidError, mintId, CriterionCheck } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { listEventsAfter } from './events';
import { insertGoal } from './goals';
import { getStakeholderTimers, setStakeholderTimers } from './stakeholder-timers';
import { insertTask } from './tasks';
import { listRoutingRules, setRoutingRules } from './routing-rules';
import type { Store } from './store';
import {
  findPersonByHandle,
  getDmCursor,
  getPerson,
  listPeople,
  removePerson,
  setDmChannel,
  setDmCursor,
  updatePerson,
  findPersonaByKey,
  insertPerson,
  insertPersona,
  listPersonas,
  patchPersona,
} from './team';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const reviewer = {
  key: 'reviewer',
  name: 'Reviewer',
  role: 'review',
  tools: 'read_only',
  instructions: 'Review the change against the acceptance criteria.',
} as const;

describe('personas', () => {
  it('inserts with defaults, finds by key, patches, and keeps the previous prompt in the event', () => {
    const { value: persona, events } = store.write((ctx) => insertPersona(ctx, reviewer));
    expect(events.map((e) => e.type)).toEqual([EventType.PersonaSaved]);
    expect(persona).toMatchObject({
      skills: [],
      archived: false,
    });
    expect(findPersonaByKey(store.db, 'reviewer')).toEqual(persona);
    const { events: saved } = store.write((ctx) =>
      patchPersona(ctx, persona.id, {
        instructions: 'Hunt for defects.',
        skills: ['review-checklist'],
      }),
    );
    expect(saved[0]?.data).toMatchObject({ previousInstructions: reviewer.instructions });
    expect(findPersonaByKey(store.db, 'reviewer')).toMatchObject({
      instructions: 'Hunt for defects.',
      skills: ['review-checklist'],
    });
    expect(listEventsAfter(store.db, 0, 10).map((e) => e.type)).toEqual([
      EventType.PersonaSaved,
      EventType.PersonaSaved,
    ]);
  });

  it('refuses a second persona with the same key', () => {
    store.write((ctx) => insertPersona(ctx, reviewer));
    expect(() => store.write((ctx) => insertPersona(ctx, reviewer))).toThrow(ConflictError);
  });

  it('leaves archived personas out of the list unless asked', () => {
    const persona = store.write((ctx) => insertPersona(ctx, reviewer)).value;
    store.write((ctx) => patchPersona(ctx, persona.id, { archived: true }));
    expect(listPersonas(store.db)).toEqual([]);
    expect(listPersonas(store.db, { includeArchived: true }).map((p) => p.key)).toEqual([
      'reviewer',
    ]);
  });
});

describe('people and routing rules', () => {
  it('finds a person by handle and replaces a project rule list', () => {
    const project = seedProject(store);
    const sam = store.write((ctx) => insertPerson(ctx, { handle: 'sam', name: 'Sam' })).value;
    expect(findPersonByHandle(store.db, 'sam')).toEqual(sam);
    const { events } = store.write((ctx) =>
      setRoutingRules(ctx, project.id, {
        rules: [{ category: 'design', area: 'ui', personId: sam.id }],
      }),
    );
    expect(events.map((e) => e.type)).toEqual([EventType.RoutingRulesSaved]);
    expect(listRoutingRules(store.db, project.id)).toMatchObject([
      { category: 'design', area: 'ui', personId: sam.id },
    ]);
    store.write((ctx) => setRoutingRules(ctx, project.id, { rules: [] }));
    expect(listRoutingRules(store.db, project.id)).toEqual([]);
  });

  it('refuses a rule for a person who does not exist and keeps the existing rules', () => {
    const project = seedProject(store);
    const sam = store.write((ctx) => insertPerson(ctx, { handle: 'sam', name: 'Sam' })).value;
    store.write((ctx) =>
      setRoutingRules(ctx, project.id, {
        rules: [{ category: 'design', area: null, personId: sam.id }],
      }),
    );
    expect(() =>
      store.write((ctx) =>
        setRoutingRules(ctx, project.id, {
          rules: [{ category: 'design', area: null, personId: mintId('Person') }],
        }),
      ),
    ).toThrow(InvalidError);
    expect(listRoutingRules(store.db, project.id)).toMatchObject([
      { category: 'design', personId: sam.id },
    ]);
  });

  it('refuses a rule for an area the project does not have', () => {
    const project = seedProject(store);
    const sam = store.write((ctx) => insertPerson(ctx, { handle: 'sam', name: 'Sam' })).value;
    expect(() =>
      store.write((ctx) =>
        setRoutingRules(ctx, project.id, {
          rules: [{ category: 'design', area: 'nope', personId: sam.id }],
        }),
      ),
    ).toThrow(InvalidError);
  });
});

const contact = { teamId: 'T1', userId: 'U1', sendMode: 'review', dailyLimit: 10 } as const;

describe('person contacts', () => {
  it('stores a contact, a null daily limit, and learns the DM channel and cursor', () => {
    const mark = store.write((ctx) =>
      insertPerson(ctx, { handle: 'mark', name: 'Mark', slack: { ...contact, dailyLimit: null } }),
    ).value;
    expect(mark.slack).toEqual({ ...contact, dailyLimit: null, dmChannelId: null });
    store.write((ctx) => {
      setDmChannel(ctx, mark.id, 'D1');
    });
    expect(getPerson(store.db, mark.id).slack?.dmChannelId).toBe('D1');
    expect(getDmCursor(store.db, mark.id)).toBeNull();
    store.write((ctx) => {
      setDmCursor(ctx, mark.id, '55.1');
    });
    expect(getDmCursor(store.db, mark.id)).toBe('55.1');
    expect(listPeople(store.db).map((p) => p.slack?.userId)).toEqual(['U1']);
  });

  it('updates a person, adds and removes the contact, and keeps the DM channel across a user change of nothing', () => {
    const mark = store.write((ctx) => insertPerson(ctx, { handle: 'mark', name: 'Mark' })).value;
    expect(mark.slack).toBeNull();
    store.write((ctx) =>
      updatePerson(ctx, mark.id, { handle: 'mark', name: 'Marcus', slack: contact }),
    );
    store.write((ctx) => {
      setDmChannel(ctx, mark.id, 'D1');
    });
    store.write((ctx) =>
      updatePerson(ctx, mark.id, {
        handle: 'mark',
        name: 'Marcus',
        slack: { ...contact, sendMode: 'auto' },
      }),
    );
    expect(getPerson(store.db, mark.id)).toMatchObject({
      name: 'Marcus',
      slack: { sendMode: 'auto', dmChannelId: 'D1' },
    });
    store.write((ctx) =>
      updatePerson(ctx, mark.id, { handle: 'mark', name: 'Marcus', slack: null }),
    );
    expect(getPerson(store.db, mark.id).slack).toBeNull();
  });

  it('forgets the DM channel when the Slack user changes', () => {
    const mark = store.write((ctx) =>
      insertPerson(ctx, { handle: 'mark', name: 'Mark', slack: contact }),
    ).value;
    store.write((ctx) => {
      setDmChannel(ctx, mark.id, 'D1');
    });
    store.write((ctx) =>
      updatePerson(ctx, mark.id, {
        handle: 'mark',
        name: 'Mark',
        slack: { ...contact, userId: 'U9' },
      }),
    );
    expect(getPerson(store.db, mark.id).slack).toMatchObject({ userId: 'U9', dmChannelId: null });
  });
});

describe('removePerson', () => {
  it('removes a person with their team rows and contact', () => {
    const project = seedProject(store);
    const sam = store.write((ctx) =>
      insertPerson(ctx, { handle: 'sam', name: 'Sam', slack: contact }),
    ).value;
    store.write((ctx) => {
      ctx.tx.insert(schema.teamMembers).values({ projectId: project.id, personId: sam.id }).run();
    });
    const { events } = store.write((ctx) => {
      removePerson(ctx, sam.id);
    });
    expect(events.map((e) => e.type)).toContain(EventType.PersonRemoved);
    expect(store.db.select().from(schema.teamMembers).all()).toEqual([]);
    expect(findPersonByHandle(store.db, 'sam')).toBeUndefined();
    expect(store.db.select().from(schema.personContacts).all()).toEqual([]);
  });

  it('refuses the builder', () => {
    const me = store.write((ctx) =>
      insertPerson(ctx, { handle: 'me', name: 'You', isBuilder: true }),
    ).value;
    expect(() =>
      store.write((ctx) => {
        removePerson(ctx, me.id);
      }),
    ).toThrow(/builder/);
  });

  it('refuses a goal owner, a person on a goal criterion, and a person a route names', () => {
    const project = seedProject(store);
    const me = store.write((ctx) =>
      insertPerson(ctx, { handle: 'me', name: 'You', isBuilder: true }),
    ).value;
    const owner = store.write((ctx) => insertPerson(ctx, { handle: 'own', name: 'Own' })).value;
    const judge = store.write((ctx) => insertPerson(ctx, { handle: 'jud', name: 'Jud' })).value;
    const routed = store.write((ctx) => insertPerson(ctx, { handle: 'rte', name: 'Rte' })).value;
    store.write((ctx) =>
      insertGoal(ctx, project.id, {
        ownerId: owner.id,
        brief: {
          title: 'G',
          objective: 'o',
          criteria: [{ text: 'ok', check: CriterionCheck.Accept, person: 'jud' }],
          people: [],
          tasks: [{ key: 'a', title: 'A', areas: ['api'], criteria: ['x'], depends_on: [] }],
        },
      }),
    );
    store.write((ctx) =>
      setRoutingRules(ctx, project.id, {
        rules: [{ category: 'design', area: null, personId: routed.id }],
      }),
    );
    expect(me.isBuilder).toBe(true);
    for (const [who, word] of [
      [owner, /goal/],
      [judge, /criterion/],
      [routed, /route/],
    ] as const) {
      expect(() =>
        store.write((ctx) => {
          removePerson(ctx, who.id);
        }),
      ).toThrow(ConflictError);
      expect(() =>
        store.write((ctx) => {
          removePerson(ctx, who.id);
        }),
      ).toThrow(word);
    }
    expect(listPeople(store.db)).toHaveLength(4);
  });
});

describe('scoped and topic routes', () => {
  function seed() {
    const project = seedProject(store);
    const other = seedProject(store, { name: 'Other', repoPath: '/tmp/other-repo' });
    const sam = store.write((ctx) => insertPerson(ctx, { handle: 'sam', name: 'Sam' })).value;
    const goal = store.write((ctx) =>
      insertGoal(ctx, project.id, {
        ownerId: sam.id,
        brief: {
          title: 'G',
          objective: 'o',
          criteria: [{ text: 'ok', check: CriterionCheck.Command }],
          people: [],
          tasks: [{ key: 'a', title: 'A', areas: ['api'], criteria: ['x'], depends_on: [] }],
        },
      }),
    ).value.goal;
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'T', acceptanceCriteria: ['x'], areas: ['ui'] }),
    ).value;
    return { project, other, sam, goal, task };
  }

  it('round-trips a goal, a task and a topic route', () => {
    const { project, sam, goal, task } = seed();
    store.write((ctx) =>
      setRoutingRules(ctx, project.id, {
        rules: [
          { category: 'product', area: null, goalId: goal.id, personId: sam.id },
          { category: 'design', area: null, taskId: task.id, personId: sam.id },
          { category: null, area: null, topic: 'billing', personId: sam.id },
        ],
      }),
    );
    expect(listRoutingRules(store.db, project.id)).toMatchObject([
      { category: 'product', goalId: goal.id, taskId: null, topic: null },
      { category: 'design', goalId: null, taskId: task.id, topic: null },
      { category: null, goalId: null, taskId: null, topic: 'billing' },
    ]);
  });

  it("refuses another project's goal or task", () => {
    const { other, sam, goal, task } = seed();
    for (const scope of [{ goalId: goal.id }, { taskId: task.id }])
      expect(() =>
        store.write((ctx) =>
          setRoutingRules(ctx, other.id, {
            rules: [{ category: 'product', area: null, personId: sam.id, ...scope }],
          }),
        ),
      ).toThrow(InvalidError);
  });

  it.each([
    ['both ids', "'product', NULL, @g, @t, NULL"],
    ['a category and a topic', "'product', NULL, NULL, NULL, 'billing'"],
    ['neither', 'NULL, NULL, NULL, NULL, NULL'],
    ['a topic with a goal', "NULL, NULL, @g, NULL, 'billing'"],
    ['a task with an area', "'product', 'ui', NULL, @t, NULL"],
  ])('the table refuses %s', (_name, values) => {
    const { project, sam, goal, task } = seed();
    const insert = store.db.$client.prepare(
      `INSERT INTO routing_rules (id, project_id, category, area, goal_id, task_id, topic, person_id, created_at, updated_at)
       VALUES ('r1', @p, ${values}, @s, 'x', 'x')`,
    );
    expect(() => insert.run({ p: project.id, s: sam.id, g: goal.id, t: task.id })).toThrow(/CHECK/);
  });
});

describe('stakeholder timers', () => {
  it('reads 4 and 8 hours with nothing stored, and round-trips', () => {
    expect(getStakeholderTimers(store.db)).toEqual({ remindAfterHours: 4, returnAfterHours: 8 });
    store.write((ctx) =>
      setStakeholderTimers(ctx, { remindAfterHours: null, returnAfterHours: 12 }),
    );
    expect(getStakeholderTimers(store.db)).toEqual({
      remindAfterHours: null,
      returnAfterHours: 12,
    });
    const { events } = store.write((ctx) =>
      setStakeholderTimers(ctx, { remindAfterHours: 2, returnAfterHours: 6 }),
    );
    expect(events.map((e) => e.type)).toContain(EventType.StakeholderTimersChanged);
  });
});
