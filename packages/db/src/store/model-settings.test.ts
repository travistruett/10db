import type { PatternMatch } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listEventsAfter } from './events';
import { listPatterns, listRoleSettings, setPatterns, setRoleSetting } from './model-settings';
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
        setting: { kind: 'tier', tier: 'fast' },
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

  it('reads in position order, which is the order given', () => {
    store.write((ctx) => {
      setPatterns(ctx, null, [
        { name: 'third', match, setting: { kind: 'automatic' } },
        { name: 'first', match, setting: { kind: 'top_of_tier' } },
        { name: 'second', match, setting: { kind: 'tier', tier: 'fast' } },
      ]);
    });
    const patterns = listPatterns(store.db);
    expect(patterns.map((p) => [p.name, p.position])).toEqual([
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
