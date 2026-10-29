import { describe, expect, it } from 'vitest';
import { parseSurveyLog } from './inspect';

describe('parseSurveyLog', () => {
  it('reads the paths of each commit, newest first, without the newline git prints after the mark', () => {
    const out = '\u0001\0\na/one.ts\0b/two.ts\0\u0001\0\nc/three.ts\0';
    expect(parseSurveyLog(out)).toEqual([['a/one.ts', 'b/two.ts'], ['c/three.ts']]);
  });

  it('leaves out a commit that changed no file', () => {
    expect(parseSurveyLog('\u0001\0\u0001\0\na.ts\0')).toEqual([['a.ts']]);
  });

  it('leaves out a commit that changed more files than a sweep', () => {
    const many = Array.from({ length: 201 }, (_, n) => `f${String(n)}.ts`).join('\0');
    expect(parseSurveyLog(`\u0001\0\n${many}\0\u0001\0\nkept.ts\0`)).toEqual([['kept.ts']]);
  });

  it('reads an empty log', () => {
    expect(parseSurveyLog('')).toEqual([]);
  });
});
