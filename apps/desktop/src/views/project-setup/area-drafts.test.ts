import { WHOLE_REPOSITORY_GLOBS } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  addDraft,
  areasOf,
  draftProblems,
  draftsFromAreas,
  mergeDrafts,
  removeDraft,
  setCatchAll,
  setGlobs,
  setName,
  WHOLE_REPOSITORY,
} from './area-drafts';

const proposed = [
  { name: 'daemon', globs: ['apps/daemon/**', 'apps/daemon/.*'], reason: 'The daemon.' },
  { name: 'desktop', globs: ['apps/desktop/**'], reason: 'The app.' },
  { name: 'root', globs: ['*', '.*'], reason: 'Top files.' },
];

const keyOf = (drafts: ReturnType<typeof draftsFromAreas>, name: string) => {
  const found = drafts.find((d) => d.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found.key;
};

describe('draftsFromAreas', () => {
  it('keeps each area apart, with its globs one to a line and its reason', () => {
    const drafts = draftsFromAreas(proposed);
    expect(drafts.map((d) => d.name)).toEqual(['daemon', 'desktop', 'root']);
    expect(drafts[0]?.globs).toBe('apps/daemon/**\napps/daemon/.*');
    expect(drafts[0]?.reason).toBe('The daemon.');
    expect(new Set(drafts.map((d) => d.key)).size).toBe(3);
  });
});

describe('areasOf', () => {
  it('sends exactly the names and globs the builder left, without blank lines or padding', () => {
    const listed = draftsFromAreas(proposed);
    const drafts = setGlobs(listed, keyOf(listed, 'desktop'), ' apps/desktop/** \n\n  docs/**  \n');
    expect(areasOf(drafts)).toEqual([
      { name: 'daemon', globs: ['apps/daemon/**', 'apps/daemon/.*'] },
      { name: 'desktop', globs: ['apps/desktop/**', 'docs/**'] },
      { name: 'root', globs: ['*', '.*'] },
    ]);
  });
});

describe('editing', () => {
  it('renames an area', () => {
    const drafts = draftsFromAreas(proposed);
    const renamed = setName(drafts, keyOf(drafts, 'desktop'), 'app');
    expect(renamed.map((d) => d.name)).toEqual(['daemon', 'app', 'root']);
  });

  it('removes an area', () => {
    const drafts = draftsFromAreas(proposed);
    expect(removeDraft(drafts, keyOf(drafts, 'root')).map((d) => d.name)).toEqual([
      'daemon',
      'desktop',
    ]);
  });

  it('merges an area into another: one name, the globs of both once', () => {
    const drafts = draftsFromAreas([
      ...proposed,
      { name: 'docs', globs: ['docs/**', '*'], reason: 'Docs.' },
    ]);
    const merged = mergeDrafts(drafts, keyOf(drafts, 'docs'), keyOf(drafts, 'root'));
    expect(merged.map((d) => d.name)).toEqual(['daemon', 'desktop', 'root']);
    expect(areasOf(merged).find((a) => a.name === 'root')?.globs).toEqual(['*', '.*', 'docs/**']);
    expect(merged.find((d) => d.name === 'root')?.reason).toBe('Top files.');
  });

  it('merging an area into itself changes nothing', () => {
    const drafts = draftsFromAreas(proposed);
    const key = keyOf(drafts, 'daemon');
    expect(mergeDrafts(drafts, key, key)).toEqual(drafts);
  });

  it('adds an empty area with a key no other has', () => {
    const drafts = addDraft(draftsFromAreas(proposed));
    expect(drafts).toHaveLength(4);
    expect(new Set(drafts.map((d) => d.key)).size).toBe(4);
    expect(drafts[3]).toMatchObject({ name: '', globs: '', reason: '' });
  });

  it('does not reuse the key of a removed area', () => {
    const drafts = draftsFromAreas(proposed);
    const last = drafts[drafts.length - 1];
    const dropped = removeDraft(drafts, last?.key ?? -1);
    const added = addDraft(dropped);
    expect(added.map((d) => d.key)).not.toContain(last?.key);
  });
});

describe('draftProblems', () => {
  it('has none for a good proposal', () => {
    expect(draftProblems(draftsFromAreas(proposed))).toEqual({ rows: new Map(), whole: null });
  });

  it('asks for at least one area', () => {
    expect(draftProblems([]).whole).toBe('Keep at least one area.');
  });

  it.each([
    ['', 'Name the area.'],
    ['Daemon App', 'Use lowercase letters, digits and hyphens, starting with a letter.'],
    ['9lives', 'Use lowercase letters, digits and hyphens, starting with a letter.'],
    ['harness', 'harness is a hazard of every new project; choose another name.'],
    ['migrations', 'migrations is a hazard of every new project; choose another name.'],
  ])('refuses the name %j', (name, message) => {
    const drafts = draftsFromAreas(proposed);
    const bad = setName(drafts, keyOf(drafts, 'desktop'), name);
    expect(draftProblems(bad).rows.get(keyOf(drafts, 'desktop'))).toMatchObject({ name: message });
  });

  it('refuses a name two areas share, on both', () => {
    const drafts = draftsFromAreas(proposed);
    const bad = setName(drafts, keyOf(drafts, 'desktop'), 'daemon');
    const { rows } = draftProblems(bad);
    expect(rows.get(keyOf(drafts, 'desktop'))?.name).toBe('Another area has this name.');
    expect(rows.get(keyOf(drafts, 'daemon'))?.name).toBe('Another area has this name.');
  });

  it.each([
    ['', 'Give at least one glob.'],
    ['  \n ', 'Give at least one glob.'],
    ['/abs/**', 'must be relative to the project folder'],
    ['../up/**', 'must not go up a folder with ..'],
    ['src\\**', 'use / between folders, not a backslash'],
    ['{a,b/**', 'has a [ or { that is never closed'],
  ])('refuses the globs %j', (globs, message) => {
    const drafts = draftsFromAreas(proposed);
    const key = keyOf(drafts, 'daemon');
    expect(draftProblems(setGlobs(drafts, key, globs)).rows.get(key)).toMatchObject({
      globs: message,
    });
  });
});

describe('the catch-all area', () => {
  const withRest = proposed.map((a) => (a.name === 'root' ? { ...a, catchAll: true } : a));
  const catchAllNames = (drafts: ReturnType<typeof draftsFromAreas>) =>
    areasOf(drafts)
      .filter((a) => a.catchAll === true)
      .map((a) => a.name);

  it('is read from the proposal and sent back as the builder left it', () => {
    const drafts = draftsFromAreas(withRest);
    expect(drafts.map((d) => d.catchAll)).toEqual([false, false, true]);
    expect(areasOf(drafts)).toEqual([
      { name: 'daemon', globs: ['apps/daemon/**', 'apps/daemon/.*'] },
      { name: 'desktop', globs: ['apps/desktop/**'] },
      { name: 'root', globs: ['*', '.*'], catchAll: true },
    ]);
  });

  it('is absent from every area of a proposal that names none', () => {
    expect(catchAllNames(draftsFromAreas(proposed))).toEqual([]);
    for (const area of areasOf(draftsFromAreas(proposed)))
      expect(area).not.toHaveProperty('catchAll');
  });

  it('moves to another area when the builder picks it, so there is never more than one', () => {
    const drafts = draftsFromAreas(withRest);
    const moved = setCatchAll(drafts, keyOf(drafts, 'daemon'), true);
    expect(catchAllNames(moved)).toEqual(['daemon']);
    expect(draftProblems(moved).whole).toBeNull();
  });

  it('can be cleared, leaving the project with none', () => {
    const drafts = draftsFromAreas(withRest);
    expect(catchAllNames(setCatchAll(drafts, keyOf(drafts, 'root'), false))).toEqual([]);
  });

  it('clearing an area that is not the catch-all changes nothing', () => {
    const drafts = draftsFromAreas(withRest);
    expect(catchAllNames(setCatchAll(drafts, keyOf(drafts, 'daemon'), false))).toEqual(['root']);
  });

  it('stays with the area it was merged into, and goes to the area that takes it in', () => {
    const drafts = draftsFromAreas(withRest);
    const intoRest = mergeDrafts(drafts, keyOf(drafts, 'daemon'), keyOf(drafts, 'root'));
    expect(catchAllNames(intoRest)).toEqual(['root']);
    const restInto = mergeDrafts(drafts, keyOf(drafts, 'root'), keyOf(drafts, 'daemon'));
    expect(catchAllNames(restInto)).toEqual(['daemon']);
  });

  it('is gone with the area when that is removed', () => {
    const drafts = draftsFromAreas(withRest);
    expect(catchAllNames(removeDraft(drafts, keyOf(drafts, 'root')))).toEqual([]);
  });

  it('is not given to an area the builder adds', () => {
    expect(addDraft(draftsFromAreas(withRest)).at(-1)?.catchAll).toBe(false);
  });

  it('is refused when two drafts say it, as the daemon would', () => {
    const drafts = draftsFromAreas(withRest).map((d) => ({ ...d, catchAll: true }));
    expect(draftProblems(drafts).whole).toBe('Only one area can be the catch-all');
  });
});

describe('WHOLE_REPOSITORY', () => {
  it('is one area over the whole repository, dotfiles and dot folders included', () => {
    expect(areasOf(draftsFromAreas([WHOLE_REPOSITORY]))).toEqual([
      { name: 'repo', globs: [...WHOLE_REPOSITORY_GLOBS] },
    ]);
  });
});
