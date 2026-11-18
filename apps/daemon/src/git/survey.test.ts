import { describe, expect, it } from 'vitest';
import { parseSurveyLog } from './inspect';

describe('parseSurveyLog', () => {
  it('reads the paths of each commit, newest first, leaving out a commit that changed no file or more than a sweep', () => {
    const many = Array.from({ length: 201 }, (_, n) => `f${String(n)}.ts`).join('\0');
    const ROWS = [
      {
        name: 'two commits, without the newline git prints after the mark',
        out: '\u0001\0\na/one.ts\0b/two.ts\0\u0001\0\nc/three.ts\0',
        paths: [['a/one.ts', 'b/two.ts'], ['c/three.ts']],
      },
      { name: 'a commit that changed no file', out: '\u0001\0\u0001\0\na.ts\0', paths: [['a.ts']] },
      {
        name: 'a commit that changed more files than a sweep',
        out: `\u0001\0\n${many}\0\u0001\0\nkept.ts\0`,
        paths: [['kept.ts']],
      },
      { name: 'an empty log', out: '', paths: [] },
    ];
    for (const { name, out, paths } of ROWS) expect.soft(parseSurveyLog(out), name).toEqual(paths);
  });
});
