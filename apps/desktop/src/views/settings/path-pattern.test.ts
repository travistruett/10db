import { describe, expect, it } from 'vitest';
import { describePathPattern } from './path-pattern';

describe('describePathPattern', () => {
  it.each([
    ['src/api/**', 'src/api/ and everything inside it', 'src/api/folder/file'],
    ['**/package.json', 'package.json in any folder', 'folder/package.json'],
    [
      '**/migrations/**',
      'migrations/ in any folder, and everything inside it',
      'folder/migrations/folder/file',
    ],
    ['pnpm-lock.yaml', 'pnpm-lock.yaml at the top of the project', 'pnpm-lock.yaml'],
    ['docs/*.md', 'files matching *.md directly in docs/', 'docs/file.md'],
    ['src/{a,b}/**', 'src/{a,b}/ and everything inside it', 'src/a/folder/file'],
    ['**', 'every file in the project', 'folder'],
    ['src/**/*.ts', 'files matching *.ts anywhere under src/', 'src/folder/file.ts'],
    ['src/*/index.ts', 'paths matching src/*/index.ts', 'src/file/index.ts'],
    ['src/api', 'src/api in the project folder', 'src/api'],
    ['!src/**', 'everything except src/ and everything inside it', 'src/folder/file'],
  ])('writes %s as a folder pattern with an example', (glob, words, example) => {
    expect(describePathPattern(glob)).toEqual({ words, example });
  });
});
