import { describe, expect, it } from 'vitest';
import { ClosureError, importClosure } from './codex-closure';

const files: Readonly<Record<string, string | undefined>> = {
  'A.ts': 'import type { B } from "./B";\nimport type { C } from "./v2/C";',
  'B.ts': 'export type B = string;',
  'v2/C.ts': 'import type { B } from "../B";\nimport type { D } from "./D";',
  'v2/D.ts': 'export type D = number;',
  'E.ts': 'export type E = boolean;',
};

const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`no ${path}`);
  return text;
};

describe('importClosure', () => {
  it.each([
    ['a seed with no imports is itself', ['B.ts'], ['B.ts']],
    [
      'follows ./ and ../ imports, once each, sorted',
      ['A.ts'],
      ['A.ts', 'B.ts', 'v2/C.ts', 'v2/D.ts'],
    ],
    ['leaves out what no seed reaches', ['A.ts'], expect.not.arrayContaining(['E.ts'])],
  ])('%s', (_name, seeds, want) => {
    expect(importClosure(read, seeds)).toEqual(want);
  });

  it('throws ClosureError naming the importer and the missing file', () => {
    const broken = (path: string): string =>
      path === 'X.ts' ? 'import type { G } from "./Gone";' : read(path);
    expect(() => importClosure(broken, ['X.ts'])).toThrow(ClosureError);
    expect(() => importClosure(broken, ['X.ts'])).toThrow(/X\.ts.*Gone\.ts/);
  });
});
