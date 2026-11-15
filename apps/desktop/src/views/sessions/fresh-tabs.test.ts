import { mintId } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FRESH_TABS_KEY,
  openFreshTab,
  readFreshTabs,
  removeFreshTab,
  setFreshModel,
  setFreshProject,
  writeFreshTabs,
} from './fresh-tabs';

const a = { id: mintId('Project') };
const b = { id: mintId('Project') };

afterEach(() => {
  localStorage.clear();
});

describe('fresh tabs', () => {
  it('opens after the given position, in the selected project', () => {
    const made = openFreshTab([], [a, b], b.id, 2, 'x');
    expect(made?.opened).toEqual({
      id: 'x',
      projectId: b.id,
      model: null,
      effort: null,
      position: 3,
    });
  });

  it('falls back to the first project, and to none when there are none', () => {
    expect(openFreshTab([], [a, b], null, 0, 'x')?.opened.projectId).toBe(a.id);
    expect(openFreshTab([], [], null, 0, 'x')).toBeNull();
  });

  it('removing a tab shifts nothing else', () => {
    const one = openFreshTab([], [a], a.id, 2, 'one');
    const two = openFreshTab(one?.tabs ?? [], [a], a.id, 4, 'two');
    expect(removeFreshTab(two?.tabs ?? [], 'one')).toEqual([
      { id: 'two', projectId: a.id, model: null, effort: null, position: 5 },
    ]);
  });

  it('changing the project clears the model, and a model is kept per tab', () => {
    const made = openFreshTab([], [a, b], a.id, 0, 'x');
    const picked = setFreshModel(made?.tabs ?? [], 'x', 'opus', 'high');
    expect(picked[0]).toMatchObject({ model: 'opus', effort: 'high' });
    expect(setFreshProject(picked, 'x', b.id)[0]).toMatchObject({
      projectId: b.id,
      model: null,
      effort: null,
    });
  });

  it('a tab kept before efforts existed reads with no effort', () => {
    localStorage.setItem(
      FRESH_TABS_KEY,
      JSON.stringify([{ id: 'x', projectId: a.id, model: 'opus', position: 0 }]),
    );
    expect(readFreshTabs()[0]).toMatchObject({ model: 'opus', effort: null });
  });

  it('round-trips through localStorage', () => {
    const made = openFreshTab([], [a], a.id, 0, 'x');
    writeFreshTabs(made?.tabs ?? []);
    expect(readFreshTabs()).toEqual(made?.tabs);
  });

  it.each([
    ['not json', '{'],
    ['the wrong shape', JSON.stringify([{ id: 1 }])],
    [
      'a project that is not an id',
      JSON.stringify([{ id: 'x', projectId: 'nope', model: null, position: 0 }]),
    ],
  ])('a corrupt value (%s) reads as no fresh tabs', (_name, raw) => {
    localStorage.setItem(FRESH_TABS_KEY, raw);
    expect(readFreshTabs()).toEqual([]);
  });
});
