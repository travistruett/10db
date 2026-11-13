import { mintId, type PatternMatch } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listEventsAfter } from './events';
import {
  clearRoleSetting,
  listPatterns,
  listRoleSettings,
  setPatterns,
  setRoleSetting,
} from './model-settings';
import * as schema from '../schema';
import { createTestStore, seedProject } from './test-support';
import type { Store } from './store';

let store: Store;
let close: () => void;

beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

describe('role settings', () => {
  it('keeps one setting per role and project, and one per role everywhere', () => {
    const project = seedProject(store);
    store.write((ctx) => {
      setRoleSetting(ctx, { role: 'implement', projectId: null, setting: { kind: 'automatic' } });
      setRoleSetting(ctx, { role: 'implement', projectId: null, setting: { kind: 'top_of_tier' } });
      setRoleSetting(ctx, {
        role: 'implement',
        projectId: project.id,
        setting: { kind: 'tier', tier: 'efficient' },
      });
      setRoleSetting(ctx, {
        role: 'implement',
        projectId: project.id,
        setting: { kind: 'model', model: 'sonnet' },
      });
      setRoleSetting(ctx, { role: 'review', projectId: null, setting: { kind: 'automatic' } });
    });
    const rows = listRoleSettings(store.db);
    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual({
      role: 'implement',
      projectId: null,
      setting: { kind: 'top_of_tier' },
    });
    expect(rows).toContainEqual({
      role: 'implement',
      projectId: project.id,
      setting: { kind: 'model', model: 'sonnet' },
    });
  });

  const auto = { kind: 'automatic' } as const;
  const uniqueCases: readonly [string, boolean | 'both', boolean][] = [
    ['a second global row for a role', false, true],
    ['a second row for a role and project', true, true],
    ['one role in both scopes', 'both', false],
  ];
  it.each(uniqueCases)('the table itself refuses %s: %s', (_name, scope, refused) => {
    const project = seedProject(store);
    const insert = (projectId: typeof project.id | null) => {
      store.write((ctx) => {
        ctx.tx
          .insert(schema.roleSettings)
          .values({ role: 'plan', projectId, setting: auto, updatedAt: ctx.now })
          .run();
      });
    };
    const first = scope === true ? project.id : null;
    insert(first);
    const second = scope === 'both' ? project.id : first;
    if (refused)
      expect(() => {
        insert(second);
      }).toThrow(/UNIQUE/);
    else
      expect(() => {
        insert(second);
      }).not.toThrow();
  });

  it('clearRoleSetting removes one scope so the role falls back, and says whether a row was there', () => {
    const project = seedProject(store);
    store.write((ctx) => {
      setRoleSetting(ctx, { role: 'qa', projectId: null, setting: { kind: 'top_of_tier' } });
      setRoleSetting(ctx, { role: 'qa', projectId: project.id, setting: auto });
    });
    const cleared = store.write((ctx) => [
      clearRoleSetting(ctx, 'qa', project.id),
      clearRoleSetting(ctx, 'qa', project.id),
    ]);
    expect(cleared.value).toEqual([true, false]);
    expect(cleared.events).toHaveLength(1);
    expect(listRoleSettings(store.db)).toEqual([
      { role: 'qa', projectId: null, setting: { kind: 'top_of_tier' } },
    ]);
  });

  it('appends an event for each change', () => {
    const before = listEventsAfter(store.db, 0, 1000).length;
    store.write((ctx) => {
      setRoleSetting(ctx, { role: 'qa', projectId: null, setting: { kind: 'automatic' } });
    });
    expect(listEventsAfter(store.db, 0, 1000)).toHaveLength(before + 1);
  });
});

describe('patterns', () => {
  const match: PatternMatch = { roles: ['review'], riskTags: [], areas: [], retryOnly: false };

  it('reads in position order, not insertion order', () => {
    store.write((ctx) => {
      for (const [name, position] of [
        ['c', 2],
        ['a', 0],
        ['b', 1],
      ] as const) {
        ctx.tx
          .insert(schema.patterns)
          .values({
            id: mintId('Pattern'),
            projectId: null,
            name,
            match,
            setting: { kind: 'automatic' },
            position,
            createdAt: ctx.now,
            updatedAt: ctx.now,
          })
          .run();
      }
    });
    expect(listPatterns(store.db).map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });

  it('stores the list given as positions 0, 1, 2', () => {
    store.write((ctx) => {
      setPatterns(ctx, null, [
        { name: 'third', match, setting: { kind: 'automatic' } },
        { name: 'first', match, setting: { kind: 'top_of_tier' } },
        { name: 'second', match, setting: { kind: 'tier', tier: 'efficient' } },
      ]);
    });
    expect(listPatterns(store.db).map((p) => [p.name, p.position])).toEqual([
      ['third', 0],
      ['first', 1],
      ['second', 2],
    ]);
  });

  it('replaces only the scope it is given', () => {
    const project = seedProject(store);
    store.write((ctx) => {
      setPatterns(ctx, null, [{ name: 'global', match, setting: { kind: 'automatic' } }]);
      setPatterns(ctx, project.id, [{ name: 'old', match, setting: { kind: 'automatic' } }]);
    });
    store.write((ctx) => {
      setPatterns(ctx, project.id, [{ name: 'new', match, setting: { kind: 'top_of_tier' } }]);
    });
    expect(listPatterns(store.db).map((p) => [p.projectId, p.name])).toEqual([
      [null, 'global'],
      [project.id, 'new'],
    ]);
  });

  it('clears a scope with an empty list', () => {
    store.write((ctx) => {
      setPatterns(ctx, null, [{ name: 'a', match, setting: { kind: 'automatic' } }]);
    });
    store.write((ctx) => {
      setPatterns(ctx, null, []);
    });
    expect(listPatterns(store.db)).toEqual([]);
  });
});
