import { describe, expect, it } from 'vitest';
import { filesTouched } from './turn-files';

// Workbench spec §4.3: "3 files changed so far". A turn's touched files are those it wrote, each once,
// by its path in the checkout.

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
  ])('$name', ({ before, written, touched }) => {
    expect(filesTouched(before, written, '/repo')).toEqual(touched);
  });
});
