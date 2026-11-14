import {
  createTestStore,
  findPersonByHandle,
  findPersonaByKey,
  listModelProfiles,
  listPersonas,
  patchPersona,
  readLegacyRouting,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { seedTeam } from './seed';

let state: StateStore;
let close: () => void;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
});
afterEach(() => {
  close();
});

describe('seedTeam', () => {
  it('seeds the personas and the builder, no model profile and nothing in the tables the playbook replaced', () => {
    seedTeam(state, readDefaultPersonas());
    expect(listModelProfiles(state.db)).toEqual([]);
    const legacy = readLegacyRouting(state.db);
    expect([legacy.flows, legacy.patterns, legacy.roleSettings, legacy.bindings]).toEqual([
      [],
      [],
      [],
      [],
    ]);
    expect(listPersonas(state.db).map((p) => p.key)).toEqual([
      'implementer',
      'plan-reviewer',
      'planner',
      'qa',
      'reviewer',
    ]);
    expect(findPersonByHandle(state.db, 'me')).toMatchObject({ isBuilder: true });
  });

  it('adds nothing the second time and keeps the builder’s edits', () => {
    seedTeam(state, readDefaultPersonas());
    const reviewer = findPersonaByKey(state.db, 'reviewer');
    if (!reviewer) throw new Error('reviewer was not seeded');
    state.write((ctx) =>
      patchPersona(ctx, reviewer.id, { instructions: 'Mine now.', archived: true }),
    );
    seedTeam(state, readDefaultPersonas());
    expect(listPersonas(state.db, { includeArchived: true })).toHaveLength(5);
    expect(findPersonaByKey(state.db, 'reviewer')).toMatchObject({
      instructions: 'Mine now.',
      archived: true,
    });
  });
});
