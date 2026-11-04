import { describe, expect, it } from 'vitest';
import { journalDirs, journalTags, ownTags, parseTag, takenNumbers } from './migration-numbers';

/** A drizzle journal holding `tags`, numbered in order as drizzle-kit writes it. */
function journal(...tags: string[]): string {
  return JSON.stringify({
    version: '7',
    dialect: 'sqlite',
    entries: tags.map((tag, idx) => ({ idx, version: '6', when: idx, tag, breakpoints: true })),
  });
}

describe("a branch's own migrations", () => {
  it('are those on neither the base nor the common ancestor', () => {
    expect(
      ownTags(
        ['0000_init', '0001_old', '0002_mine'],
        ['0000_init', '0001_theirs'],
        ['0000_init', '0001_old'],
      ),
    ).toEqual(['0002_mine']);
  });

  it('come in the order of their journal', () => {
    const text = JSON.stringify({
      entries: [
        { idx: 1, tag: '0001_b' },
        { idx: 0, tag: '0000_a' },
      ],
    });
    expect(journalTags(text)).toEqual(['0000_a', '0001_b']);
  });

  it.each([null, 'not json', '["0000"]'])('are unknown from the journal %s', (text) => {
    expect(journalTags(text)).toBeNull();
  });

  it.each([
    ['0042_add_x', { number: '0042', name: 'add_x' }],
    ['0043_it-works', { number: '0043', name: 'it-works' }],
    ['add_x', null],
    ['0042_../up', null],
    ['0042_-flag', null],
  ])('tag %s reads as %j', (tag, parsed) => {
    expect(parseTag(tag)).toEqual(parsed);
  });
});

describe('the drizzle directories a conflict touches', () => {
  it('are the ones whose journal conflicts, once each and sorted', () => {
    expect(
      journalDirs([
        'README.md',
        'packages/db/drizzle/meta/_journal.json',
        'packages/db/drizzle/meta/0009_snapshot.json',
        'apps/other/drizzle/meta/_journal.json',
        'meta/_journal.json',
      ]),
    ).toEqual(['.', 'apps/other/drizzle', 'packages/db/drizzle']);
  });

  it('are none when no journal conflicts', () => {
    expect(journalDirs(['packages/db/drizzle/0009_x.sql', 'src/a.ts'])).toEqual([]);
  });
});

describe("the branch's migrations whose number the base already gives another", () => {
  it('names each with the one on the base that has its number', () => {
    expect(
      takenNumbers(
        'packages/db/drizzle',
        journal('0000_init', '0001_branch', '0002_branch_more'),
        journal('0000_init', '0001_track_prs', '0002_routing'),
      ),
    ).toEqual([
      { dir: 'packages/db/drizzle', number: '0001', ours: '0001_branch', theirs: '0001_track_prs' },
      {
        dir: 'packages/db/drizzle',
        number: '0002',
        ours: '0002_branch_more',
        theirs: '0002_routing',
      },
    ]);
  });

  it('are none when the base has nothing past the branch, or the branch generated after it', () => {
    expect(takenNumbers('d', journal('0000_init', '0001_branch'), journal('0000_init'))).toEqual(
      [],
    );
    expect(
      takenNumbers(
        'd',
        journal('0000_init', '0001_track_prs', '0002_branch'),
        journal('0000_init', '0001_track_prs'),
      ),
    ).toEqual([]);
  });

  it('are none when either journal is missing or is not one drizzle-kit wrote', () => {
    expect(takenNumbers('d', null, journal('0000_init'))).toEqual([]);
    expect(takenNumbers('d', journal('0000_init'), '<<<<<<< ours')).toEqual([]);
    expect(takenNumbers('d', '{"entries": [{"idx": "one"}]}', journal('0000_init'))).toEqual([]);
  });
});
