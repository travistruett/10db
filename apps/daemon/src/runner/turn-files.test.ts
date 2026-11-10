import { describe, expect, it } from 'vitest';
import { filesTouched, MAX_FILES_TOUCHED } from './turn-files';

// Workbench spec §4.3: "3 files changed so far". A turn's touched files are those it wrote, each once,
// by its path in the checkout.

/** As many files as a turn's row carries. */
const CAPPED = Array.from({ length: MAX_FILES_TOUCHED }, (_, n) => `src/f${String(n)}.ts`);

describe('filesTouched', () => {
  it.each<{ name: string; before: string[]; written: string[]; touched: string[] }>([
    { name: 'adds a written file', before: [], written: ['src/a.ts'], touched: ['src/a.ts'] },
    {
      name: 'keeps each file once, in the order first written',
      before: ['src/b.ts', 'src/a.ts'],
      written: ['src/a.ts', 'src/c.ts'],
      touched: ['src/b.ts', 'src/a.ts', 'src/c.ts'],
    },
    {
      name: 'names a file under the checkout by its path in it',
      before: [],
      written: ['/repo/src/a.ts'],
      touched: ['src/a.ts'],
    },
    {
      name: 'keeps a file outside the checkout as it was named',
      before: [],
      written: ['/elsewhere/a.ts', '../up.ts'],
      touched: ['/elsewhere/a.ts', '../up.ts'],
    },
    {
      name: 'adds nothing for a call that wrote nothing',
      before: ['a'],
      written: [],
      touched: ['a'],
    },
    {
      name: 'stops at the cap, keeping the files first written',
      before: CAPPED,
      written: ['src/one-more.ts'],
      touched: CAPPED,
    },
  ])('$name', ({ before, written, touched }) => {
    expect(filesTouched(before, written, '/repo')).toEqual(touched);
  });
});
