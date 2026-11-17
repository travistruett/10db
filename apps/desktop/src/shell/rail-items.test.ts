import { describe, expect, it } from 'vitest';
import { RAIL_ITEMS, RAIL_ORDER, railSectionForPath, type RailEntry } from './rail-items';

function describeEntry(entry: RailEntry): string {
  switch (entry.kind) {
    case 'item':
      return RAIL_ITEMS[entry.section].label;
    case 'control':
      return `control:${entry.control}`;
    case 'divider':
    case 'project-tile':
    case 'spacer':
      return entry.kind;
  }
}

describe('the rail', () => {
  it('orders global sections, the project tile and its sections, then the foot', () => {
    expect(RAIL_ORDER.map(describeEntry)).toEqual([
      'Inbox',
      'Factory',
      'Sessions',
      'divider',
      'project-tile',
      'Board',
      'Plan',
      'UI Workbench',
      'Knowledge',
      'spacer',
      'control:download',
      'control:daemon',
      'control:keep-awake',
      'control:color-scheme',
      'Settings',
    ]);
  });

  it.each([
    { path: '/inbox', section: 'inbox' },
    { path: '/sessions/abc', section: 'sessions' },
    { path: '/shape/s1', section: 'plan' },
    { path: '/shape', section: 'plan' },
    { path: '/settings/general', section: 'settings' },
    { path: '/workbench', section: 'workbench' },
    { path: '/shapely', section: null },
    { path: '/', section: null },
  ])('$path belongs to $section', ({ path, section }) => {
    expect(railSectionForPath(path)).toBe(section);
  });
});
