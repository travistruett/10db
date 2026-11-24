import { describe, expect, it } from 'vitest';
import { checkCoverage, coverageNote } from './check-coverage';

const CHANGED = [
  'amps/frontend/a.ts',
  'amps/backend/apps/access/grants.py',
  'amps/backend/b.py',
  'docs/x.md',
];

describe('checkCoverage', () => {
  const cases: readonly [string, string, readonly string[] | null][] = [
    [
      'pnpm --dir',
      'pnpm --dir amps/frontend run typecheck && pnpm --dir amps/frontend run lint',
      ['amps/backend/apps/access/grants.py', 'amps/backend/b.py', 'docs/x.md'],
    ],
    [
      'prefix equals form',
      'npm --prefix=./amps/frontend test',
      ['amps/backend/apps/access/grants.py', 'amps/backend/b.py', 'docs/x.md'],
    ],
    [
      'cd then run',
      'cd amps/frontend && pnpm lint',
      ['amps/backend/apps/access/grants.py', 'amps/backend/b.py', 'docs/x.md'],
    ],
    [
      'chained cds compose with a flag',
      'cd amps && pnpm --dir frontend lint',
      ['amps/backend/apps/access/grants.py', 'amps/backend/b.py', 'docs/x.md'],
    ],
    [
      'quoted folder',
      "pnpm --dir 'amps/frontend' lint",
      ['amps/backend/apps/access/grants.py', 'amps/backend/b.py', 'docs/x.md'],
    ],
    ['variable folder has no claim', 'pnpm --dir $APP lint', null],
    ['outside the checkout has no claim', 'pnpm --dir /elsewhere lint', null],
    [
      '-C counts after make',
      'make -C amps/frontend lint',
      ['amps/backend/apps/access/grants.py', 'amps/backend/b.py', 'docs/x.md'],
    ],
    ['-C is context after grep', 'grep -C 3 foo file', null],
    ['make has no claim', 'make check', null],
    ['unknown has no claim', 'pnpm run typecheck', null],
    ['one unscoped segment has no claim', 'pnpm --dir amps/frontend lint && make test', null],
  ];
  it.each(cases)('%s', (_name, command, unchecked) => {
    const result = checkCoverage(command, CHANGED, '/repo');
    expect(result === null ? null : result.unchecked).toEqual(unchecked);
  });

  it('makes an absolute folder checkout-relative', () => {
    expect(checkCoverage('pnpm --dir /repo/amps/frontend lint', CHANGED, '/repo')?.covers).toEqual([
      'amps/frontend',
    ]);
  });

  it('says what was left out in one line', () => {
    expect(coverageNote(checkCoverage('pnpm --dir amps/frontend lint', CHANGED))).toBe(
      'check covers amps/frontend; amps/backend/apps/access/grants.py and 2 more not checked',
    );
    expect(
      coverageNote(checkCoverage('pnpm --dir amps/frontend lint', ['amps/frontend/a.ts'])),
    ).toBeNull();
  });
});
