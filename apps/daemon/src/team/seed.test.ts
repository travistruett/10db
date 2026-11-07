import {
  createTestStore,
  findPersonByHandle,
  findPersonaByKey,
  listFlows,
  listPatterns,
  listModelProfiles,
  listPersonas,
  patchPersona,
  setPatterns,
  type NewPattern,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { DEFAULT_FLOWS, SEED_PROFILES } from '../routing';
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
  it('seeds unmeasured profiles, the flows, the personas and the builder', () => {
    seedTeam(state, readDefaultPersonas());
    const profiles = listModelProfiles(state.db);
    expect(profiles).toHaveLength(SEED_PROFILES.length);
    expect(
      profiles.every(
        (p) => p.scores.coding === null && p.costPerTaskUsd === null && p.source === 'aa',
      ),
    ).toBe(true);
    expect(profiles.find((p) => p.model === 'opus' && p.effort === 'high')?.aaSlug).toBe(
      'claude-opus-5-5-high',
    );
    expect(profiles.find((p) => p.model === 'opus' && p.effort === 'max')?.aaSlug).toBe(
      'claude-opus-5-5',
    );
    expect(profiles.filter((p) => p.model === 'fable').every((p) => !p.enabled)).toBe(true);
    expect(
      listFlows(state.db)
        .map((f) => f.name)
        .sort(),
    ).toEqual(DEFAULT_FLOWS.map((f) => f.name).sort());
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
    expect(listModelProfiles(state.db)).toHaveLength(SEED_PROFILES.length);
    expect(listPersonas(state.db, { includeArchived: true })).toHaveLength(5);
    expect(findPersonaByKey(state.db, 'reviewer')).toMatchObject({
      instructions: 'Mine now.',
      archived: true,
    });
  });
});

describe('seedTeam’s pattern', () => {
  it('adds the high-risk pattern once', () => {
    seedTeam(state, readDefaultPersonas());
    expect(listPatterns(state.db)).toMatchObject([
      {
        projectId: null,
        name: 'High-risk work',
        match: {
          roles: [],
          riskTags: ['security', 'auth', 'migration'],
          areas: [],
          retryOnly: false,
        },
        setting: { kind: 'top_of_tier' },
        position: 0,
      },
    ]);
  });

  it.each([
    { name: 'deleted', patterns: [] },
    {
      name: 'edited',
      patterns: [
        {
          name: 'Mine',
          match: { roles: [], riskTags: [], areas: [], retryOnly: true },
          setting: { kind: 'automatic' },
        },
      ],
    },
  ] satisfies { name: string; patterns: NewPattern[] }[])(
    'does not undo a pattern the builder $name',
    ({ patterns }) => {
      seedTeam(state, readDefaultPersonas());
      state.write((ctx) => {
        setPatterns(ctx, null, patterns);
      });
      const kept = listPatterns(state.db).map((p) => [p.name, p.match]);
      seedTeam(state, readDefaultPersonas());
      expect(listPatterns(state.db).map((p) => [p.name, p.match])).toEqual(kept);
    },
  );

  it('adds nothing beside patterns the builder already has when it first runs', () => {
    state.write((ctx) => {
      setPatterns(ctx, null, [
        {
          name: 'Mine',
          match: { roles: [], riskTags: [], areas: [], retryOnly: false },
          setting: { kind: 'automatic' },
        },
      ]);
    });
    seedTeam(state, readDefaultPersonas());
    expect(listPatterns(state.db).map((p) => p.name)).toEqual(['Mine']);
  });
});
