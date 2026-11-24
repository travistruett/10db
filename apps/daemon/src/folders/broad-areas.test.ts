import { AreaRole, type AreaDef } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { globReaches, treeGlobs } from './area-candidates';
import { broadAreaSplit } from './broad-areas';

/** A Django backend: an `apps/` of apps beside config, tests and a manage.py. */
const DJANGO = [
  'be/manage.py',
  'be/.env.example',
  'be/config/__init__.py',
  'be/config/settings.py',
  'be/test_utils/__init__.py',
  'be/test_utils/db.py',
  'be/apps/__init__.py',
  ...['core', 'billing', 'search', 'people'].flatMap((app) => [
    `be/apps/${app}/__init__.py`,
    `be/apps/${app}/apps.py`,
    `be/apps/${app}/models.py`,
    `be/apps/${app}/migrations/__init__.py`,
    `be/apps/${app}/migrations/0001_initial.py`,
    `be/apps/${app}/tests/__init__.py`,
    `be/apps/${app}/services/__init__.py`,
  ]),
];

const whole = (root: string, files: readonly string[], extra: Partial<AreaDef> = {}): AreaDef => ({
  name: 'backend',
  globs: treeGlobs(root, files),
  ...extra,
});

const names = (result: ReturnType<typeof broadAreaSplit>) =>
  result === null ? null : [result.core.name, ...result.parts.map((p) => p.name)];

describe('broadAreaSplit', () => {
  it.each([
    {
      why: 'a Django apps folder splits per app, core-named apps staying in the core',
      area: whole('be', DJANGO),
      files: DJANGO,
      taken: ['people'],
      split: ['backend', 'billing', 'backend-people', 'search'],
    },
    {
      why: "one app's subpackages, each with an __init__.py, are no units",
      area: whole('be/apps/billing', DJANGO),
      files: DJANGO,
      taken: [],
      split: null,
    },
    {
      why: 'two packages are too few',
      area: whole('pk', ['pk/a/package.json', 'pk/a/i.ts', 'pk/b/package.json', 'pk/b/i.ts']),
      files: ['pk/a/package.json', 'pk/a/i.ts', 'pk/b/package.json', 'pk/b/i.ts'],
      taken: [],
      split: null,
    },
    {
      why: 'packages under fixtures are test data',
      area: whole('tests', [
        'tests/run.ts',
        ...['a', 'b', 'c'].map((n) => `tests/fixtures/${n}/package.json`),
      ]),
      files: ['tests/run.ts', ...['a', 'b', 'c'].map((n) => `tests/fixtures/${n}/package.json`)],
      taken: [],
      split: null,
    },
    {
      why: 'a page area is never split',
      area: whole('be', DJANGO, { role: AreaRole.Page }),
      files: DJANGO,
      taken: [],
      split: null,
    },
  ])('$why', ({ area, files, taken, split }) => {
    const result = broadAreaSplit(area, files, new Set(taken));
    expect(names(result)).toEqual(split);
    if (result === null) return;
    // Every file of the area lands in exactly one of the core and the parts.
    const all = [result.core, ...result.parts];
    for (const file of files.filter((f) => f.startsWith('be/')))
      expect(all.filter((a) => a.globs.some((g) => globReaches(file, g))).length).toBe(1);
    expect(result.core.globs).toEqual(
      expect.arrayContaining(['be/*', 'be/.*', 'be/apps/*', 'be/config/**', 'be/apps/core/**']),
    );
  });
});
