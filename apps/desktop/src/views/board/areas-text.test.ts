import { describe, expect, it } from 'vitest';
import { criteriaLines, formatAreas, parseAreas } from './areas-text';

describe('parseAreas', () => {
  it.each([
    ['one area', 'api: src/api/**', [{ name: 'api', globs: ['src/api/**'] }]],
    [
      'several areas, blank lines and spaces',
      '\n  api: src/api/** , src/shared/api/**\n\nui:src/ui/**\n',
      [
        { name: 'api', globs: ['src/api/**', 'src/shared/api/**'] },
        { name: 'ui', globs: ['src/ui/**'] },
      ],
    ],
  ])('parses %s', (_name, text, areas) => {
    expect(parseAreas(text)).toEqual({ ok: true, areas });
  });

  it.each([
    ['no colon', 'api src/**', 'Line 1: write each area as "name: glob, glob"'],
    [
      'an uppercase name',
      'api: a/**\nAPI: src/**',
      'Line 2: "API" must use lowercase letters, digits and hyphens',
    ],
    ['no globs', 'api: ,', 'Line 1: area api needs at least one glob'],
    ['a duplicate', 'api: a/**\napi: b/**', 'Line 2: area api is listed twice'],
    ['nothing', '  \n ', 'Add at least one area'],
  ])('rejects %s with a message naming the line', (_name, text, error) => {
    expect(parseAreas(text)).toEqual({ ok: false, error });
  });
});

describe('formatAreas', () => {
  it('round-trips through parseAreas', () => {
    const areas = [
      { name: 'api', globs: ['src/api/**', 'src/shared/**'] },
      { name: 'ui', globs: ['src/ui/**'] },
    ];
    expect(formatAreas(areas)).toBe('api: src/api/**, src/shared/**\nui: src/ui/**');
    expect(parseAreas(formatAreas(areas))).toEqual({ ok: true, areas });
  });
});

describe('criteriaLines', () => {
  it('keeps one trimmed criterion per non-blank line', () => {
    expect(criteriaLines(' It works \n\n  It is tested\n')).toEqual(['It works', 'It is tested']);
  });
});
