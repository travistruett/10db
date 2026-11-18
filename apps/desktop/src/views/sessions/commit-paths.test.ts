import { describe, expect, it } from 'vitest';
import { commitFiles } from './commit-paths';

describe('commitFiles', () => {
  it.each([
    {
      name: 'checks what the session touched and lists the rest unchecked',
      changed: ['src/b.ts', 'src/a.ts', '.env'],
      touched: ['src/a.ts', 'src/b.ts'],
      files: ['.env', 'src/a.ts', 'src/b.ts'],
      checked: ['src/a.ts', 'src/b.ts'],
    },
    {
      name: 'drops a touched file that git does not list as changed',
      changed: ['src/a.ts'],
      touched: ['src/a.ts', 'src/gone.ts'],
      files: ['src/a.ts'],
      checked: ['src/a.ts'],
    },
    {
      name: 'checks nothing when the session touched nothing listed, as after a shell write',
      changed: ['src/a.ts'],
      touched: [],
      files: ['src/a.ts'],
      checked: [],
    },
    {
      name: 'lists a path once',
      changed: ['src/a.ts', 'src/a.ts'],
      touched: ['src/a.ts'],
      files: ['src/a.ts'],
      checked: ['src/a.ts'],
    },
  ])('$name', ({ changed, touched, files, checked }) => {
    expect(commitFiles(changed, touched)).toEqual({ files, checked });
  });
});
