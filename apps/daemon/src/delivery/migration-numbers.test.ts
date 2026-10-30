import { describe, expect, it } from 'vitest';
import { journalDirs, takenNumbers } from './migration-numbers';

/** A drizzle journal holding `tags`, numbered in order as drizzle-kit writes it. */
function journal(...tags: string[]): string {
  return JSON.stringify({
    version: '7',
    dialect: 'sqlite',
    entries: tags.map((tag, idx) => ({ idx, version: '6', when: idx, tag, breakpoints: true })),
  });
}

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
