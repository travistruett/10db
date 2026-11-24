import { AreaRole, SettingField, type AreaDef, type WorkbenchSetupDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  areasChanged,
  areasSummary,
  leftOutAfter,
  newPagesOf,
  setUpCount,
  setupPatch,
  suggestionCount,
} from './setup-rules';

const CURRENT: AreaDef[] = [
  { name: 'repo', globs: ['**'] },
  { name: 'backend', globs: ['api/**'] },
];
const PROPOSED: AreaDef[] = [
  { name: 'repo', globs: ['**'] },
  { name: 'board', globs: ['src/views/board/**'], role: AreaRole.Page, route: '/board' },
  { name: 'inbox', globs: ['app/inbox/**'], role: AreaRole.Page, route: '/inbox' },
  { name: 'ui-shared', globs: ['src/**'], role: AreaRole.Shared },
  { name: 'backend', globs: ['api/**'] },
];
const SETUP: WorkbenchSetupDto = {
  areas: {
    proposed: PROPOSED,
    kept: [{ name: 'repo', reason: 'kept: 2 open tasks name it' }],
    pages: [
      { name: 'board', route: '/board', folders: ['src/views/board/'] },
      { name: 'inbox', route: '/inbox', folders: ['app/inbox/'] },
    ],
    skipped: [],
    splits: [],
  },
  settings: [
    { field: SettingField.AppUrl, value: 'http://localhost:1420', source: 'from tauri.conf.json' },
  ],
};

describe('setupPatch', () => {
  it.each([
    {
      name: 'everything ticked saves the proposed list and the setting',
      unticked: [],
      settings: { appUrl: 'http://localhost:1420' },
      patch: { areas: PROPOSED, appUrl: 'http://localhost:1420' },
    },
    {
      name: 'an unticked page is folded back into the shared area that holds its files',
      unticked: ['board'],
      settings: {},
      patch: { areas: PROPOSED.filter((a) => a.name !== 'board'), leftOutPages: ['board'] },
    },
    {
      name: 'an unticked page no shared area holds stays an area with no role',
      unticked: ['inbox'],
      settings: {},
      patch: {
        areas: PROPOSED.map((a) =>
          a.name === 'inbox' ? { name: 'inbox', globs: ['app/inbox/**'] } : a,
        ),
        leftOutPages: ['inbox'],
      },
    },
  ])('$name', ({ unticked, settings, patch }) => {
    expect(setupPatch(SETUP, CURRENT, unticked, settings)).toEqual(patch);
  });

  it('puts a kept area that became a page back exactly when that page is unticked', () => {
    const was: AreaDef = { name: 'board', globs: ['src/views/board/**', 'docs/board.md'] };
    const kept = {
      ...SETUP,
      areas: {
        ...SETUP.areas,
        pages: SETUP.areas.pages.map((p) => (p.name === 'board' ? { ...p, was } : p)),
      },
    };
    expect(setupPatch(kept, CURRENT, ['board'], {})?.areas).toEqual(
      PROPOSED.map((a) => (a.name === 'board' ? was : a)),
    );
  });

  it('leaves the areas out when the rebuild is not ticked, unless a split is', () => {
    expect(setupPatch(SETUP, CURRENT, [], { appUrl: 'http://localhost:1420' }, false)).toEqual({
      appUrl: 'http://localhost:1420',
    });
    expect(setupPatch(SETUP, CURRENT, [], {}, false)).toBeNull();
    // A split always travels with the open tasks' retag, so none is left on the narrowed name.
    const split = {
      ...SETUP,
      areas: {
        ...SETUP.areas,
        splits: [
          {
            from: 'repo',
            into: [
              { name: 'repo', globs: ['*'] },
              { name: 'billing', globs: ['billing/**'] },
            ],
            was: { name: 'repo', globs: ['**'] },
            tasks: 2,
          },
        ],
      },
    };
    expect(setupPatch(split, CURRENT, [], {}, false)).toMatchObject({
      areas: [
        { name: 'repo', globs: ['*'] },
        { name: 'billing', globs: ['billing/**'] },
        ...CURRENT.slice(1),
      ],
      areaSplits: [{ from: 'repo', into: ['repo', 'billing'] }],
    });
    expect(setupPatch(split, CURRENT, ['repo'], {}, false)).toEqual({ leftOutPages: ['repo'] });
  });

  it('leaves the areas out when the result is the list the project has', () => {
    const same = { ...SETUP, areas: { ...SETUP.areas, proposed: CURRENT, pages: [] } };
    expect(setupPatch(same, CURRENT, [], { appUrl: 'http://localhost:1420' })).toEqual({
      appUrl: 'http://localhost:1420',
    });
    expect(setupPatch(same, CURRENT, [], {})).toBeNull();
  });
});

describe('areasChanged and suggestionCount', () => {
  it('counts the page and setting rows, and sees a list that differs only in order as the same', () => {
    expect(suggestionCount(SETUP)).toBe(3);
    expect(areasChanged(PROPOSED, CURRENT)).toBe(true);
    expect(areasChanged([...CURRENT].reverse(), CURRENT)).toBe(false);
  });
});

describe('setUpCount and newPagesOf', () => {
  const SPLIT = {
    from: 'backend',
    into: [
      { name: 'backend', globs: ['api/*'] },
      { name: 'billing', globs: ['api/billing/**'] },
    ],
    was: { name: 'backend', globs: ['api/**'] },
    tasks: 2,
  };
  it.each<{ name: string; setup: WorkbenchSetupDto; leftOut: string[]; count: number }>([
    { name: 'two new pages and a setting', setup: SETUP, leftOut: [], count: 3 },
    { name: 'a page left out is not counted', setup: SETUP, leftOut: ['inbox'], count: 2 },
    {
      name: 'every page left out leaves the settings',
      setup: SETUP,
      leftOut: ['board', 'inbox'],
      count: 1,
    },
    {
      name: 'a name that is no new page changes nothing',
      setup: SETUP,
      leftOut: ['gone'],
      count: 3,
    },
    {
      name: 'a split is counted until it is left out',
      setup: { ...SETUP, areas: { ...SETUP.areas, splits: [SPLIT] } },
      leftOut: ['backend'],
      count: 3,
    },
    {
      name: 'nothing found counts nothing',
      setup: { ...SETUP, settings: [], areas: { ...SETUP.areas, pages: [] } },
      leftOut: [],
      count: 0,
    },
  ])('$name', ({ setup, leftOut, count }) => {
    expect(setUpCount(setup, leftOut)).toBe(count);
    expect(newPagesOf(setup, leftOut).length).toBe(count - setup.settings.length);
  });
});

describe('leftOutAfter and what Apply sends of it', () => {
  it.each<{ name: string; leftOut: string[]; unticked: string[]; after: string[] }>([
    { name: 'an unticked page is added', leftOut: [], unticked: ['inbox'], after: ['inbox'] },
    {
      name: 'a ticked page that was left out is removed',
      leftOut: ['inbox'],
      unticked: [],
      after: [],
    },
    {
      name: 'a page left out and left unticked stays once',
      leftOut: ['inbox'],
      unticked: ['inbox'],
      after: ['inbox'],
    },
    {
      name: 'a name no longer found stays',
      leftOut: ['gone'],
      unticked: ['board'],
      after: ['gone', 'board'],
    },
  ])('$name', ({ leftOut, unticked, after }) => {
    expect(leftOutAfter(SETUP, leftOut, unticked)).toEqual(after);
  });

  it('sends the left-out pages with the areas, only when they change', () => {
    expect(setupPatch(SETUP, CURRENT, ['inbox'], {}, true, [])?.leftOutPages).toEqual(['inbox']);
    expect(setupPatch(SETUP, CURRENT, [], {}, true, ['inbox'])?.leftOutPages).toEqual([]);
    expect(setupPatch(SETUP, CURRENT, ['inbox'], {}, true, ['inbox'])).not.toHaveProperty(
      'leftOutPages',
    );
    // Leaving a page out never needs the rebuild: with it unticked only the list is sent.
    expect(setupPatch(SETUP, CURRENT, ['inbox'], {}, false, [])).toEqual({
      leftOutPages: ['inbox'],
    });
    expect(setupPatch(SETUP, CURRENT, [], {}, false, [])).toBeNull();
  });
});

describe('a label difference', () => {
  it('is a change, so a label-only rebuild is offered and sent', () => {
    const labelled = PROPOSED.map((a) => (a.name === 'board' ? { ...a, label: 'Work' } : a));
    expect(areasChanged(labelled, PROPOSED)).toBe(true);
    expect(areasChanged(PROPOSED, PROPOSED)).toBe(false);
    const setup = { ...SETUP, areas: { ...SETUP.areas, proposed: labelled, pages: [] } };
    expect(setupPatch(setup, PROPOSED, [], {})?.areas).toEqual(labelled);
  });
});

describe('areasSummary', () => {
  it('says how many page labels the rebuild sets, whatever else it changes', () => {
    const labelled = PROPOSED.map((a) => (a.role === AreaRole.Page ? { ...a, label: 'X' } : a));
    expect(areasSummary(PROPOSED, labelled)).toBe(
      '5 areas → 5: 2 pages, 1 shared, 2 other; repo, board, inbox and 2 more keep their names; 2 page labels set',
    );
    expect(areasSummary(PROPOSED, PROPOSED)).not.toContain('label');
    const one = PROPOSED.map((a) => (a.name === 'board' ? { ...a, label: 'Work' } : a));
    expect(areasSummary(PROPOSED, one)).toContain('; 1 page label set');
  });

  it('says how many areas become how many, of which kind, and which names stay', () => {
    expect(areasSummary(CURRENT, PROPOSED)).toBe(
      '2 areas → 5: 2 pages, 1 shared, 2 other; repo and backend keep their names',
    );
  });

  it('names three that stay and counts the rest', () => {
    const names = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, globs: [`${name}/**`] }));
    expect(areasSummary(names, names)).toBe(
      '5 areas → 5: 0 pages, 0 shared, 5 other; a, b, c and 2 more keep their names',
    );
  });
});
