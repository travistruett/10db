import { AreaRole, SettingField, type AreaDef, type WorkbenchSetupDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { areasChanged, areasSummary, setupPatch, suggestionCount } from './setup-rules';

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
  },
  settings: [
    { field: SettingField.AppUrl, value: 'http://localhost:1420', source: 'from tauri.conf.json' },
  ],
  branch: null,
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
      patch: { areas: PROPOSED.filter((a) => a.name !== 'board') },
    },
    {
      name: 'an unticked page no shared area holds stays an area with no role',
      unticked: ['inbox'],
      settings: {},
      patch: {
        areas: PROPOSED.map((a) =>
          a.name === 'inbox' ? { name: 'inbox', globs: ['app/inbox/**'] } : a,
        ),
      },
    },
  ])('$name', ({ unticked, settings, patch }) => {
    expect(setupPatch(SETUP, CURRENT, unticked, settings)).toEqual(patch);
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

describe('areasSummary', () => {
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
