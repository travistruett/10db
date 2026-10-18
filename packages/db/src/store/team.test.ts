import { ConflictError, EventType, InvalidError, type PersonaId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listEventsAfter } from './events';
import { listRoutingRules, setRoutingRules } from './routing-rules';
import type { Store } from './store';
import {
  findPersonByHandle,
  findPersonaByKey,
  getTeam,
  insertPerson,
  insertPersona,
  listPersonas,
  patchPersona,
  setTeam,
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
      minimumScore: null,
      modelPin: null,
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

describe('team', () => {
  it('starts empty, then replaces bindings and members as a whole', () => {
    const project = seedProject(store);
    expect(getTeam(store.db, project.id)).toEqual({
      projectId: project.id,
      bindings: [],
      members: [],
    });
    const persona = store.write((ctx) => insertPersona(ctx, reviewer)).value;
    const sam = store.write((ctx) => insertPerson(ctx, { handle: 'sam', name: 'Sam' })).value;
    const { events } = store.write((ctx) =>
      setTeam(ctx, project.id, {
        bindings: [{ role: 'review', personaId: persona.id }],
        members: [sam.id],
      }),
    );
    expect(events.map((e) => e.type)).toEqual([EventType.TeamSaved]);
    expect(getTeam(store.db, project.id)).toEqual({
      projectId: project.id,
      bindings: [{ role: 'review', personaId: persona.id }],
      members: [sam.id],
    });
    store.write((ctx) => setTeam(ctx, project.id, { bindings: [], members: [] }));
    expect(getTeam(store.db, project.id).bindings).toEqual([]);
  });

  it.each([
    {
      name: 'a persona bound to a role it does not have',
      bind: (id: PersonaId) => ({ role: 'implement' as const, personaId: id }),
      archive: false,
    },
    {
      name: 'an archived persona',
      bind: (id: PersonaId) => ({ role: 'review' as const, personaId: id }),
      archive: true,
    },
  ])('refuses $name', ({ bind, archive }) => {
    const project = seedProject(store);
    const persona = store.write((ctx) => insertPersona(ctx, reviewer)).value;
    if (archive) store.write((ctx) => patchPersona(ctx, persona.id, { archived: true }));
    expect(() =>
      store.write((ctx) => setTeam(ctx, project.id, { bindings: [bind(persona.id)], members: [] })),
    ).toThrow(InvalidError);
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
