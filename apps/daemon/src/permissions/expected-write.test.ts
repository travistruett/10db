import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { expectedWriteIn, expectedWriteOf, matchesExpectedWrite } from './expected-write';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('expectedWriteOf', () => {
  it('names the whole content a Write puts in', () => {
    expect(expectedWriteOf('Write', { file_path: 'a', content: 'hello' })).toEqual({
      sha256: sha('hello'),
    });
  });

  it('names the text an Edit and a MultiEdit put in', () => {
    expect(expectedWriteOf('Edit', { old_string: 'a', new_string: 'b' })).toEqual({
      contains: ['b'],
    });
    expect(
      expectedWriteOf('MultiEdit', { edits: [{ new_string: 'b' }, { new_string: '' }] }),
    ).toEqual({ contains: ['b'] });
  });

  it.each([
    ['an Edit that only deletes', 'Edit', { old_string: 'a', new_string: '' }],
    ['a Write with no content', 'Write', { file_path: 'a' }],
    ['a NotebookEdit', 'NotebookEdit', { new_source: 'x' }],
    ['an Edit too large to keep', 'Edit', { new_string: 'x'.repeat(300 * 1024) }],
    ['a MultiEdit with a part that is no text', 'MultiEdit', { edits: [{ new_string: 1 }] }],
  ])('names nothing for %s', (_name, tool, input) => {
    expect(expectedWriteOf(tool, input)).toBeUndefined();
  });
});

describe('expectedWriteIn', () => {
  it('reads a well-formed expectation and nothing else', () => {
    expect(expectedWriteIn({ expectedWrite: { contains: ['x'] } })).toEqual({ contains: ['x'] });
    expect(expectedWriteIn({ expectedWrite: { sha256: 'nope' } })).toBeUndefined();
    expect(expectedWriteIn({ expectedWrite: { contains: [] } })).toBeUndefined();
    expect(expectedWriteIn(null)).toBeUndefined();
  });
});

describe('matchesExpectedWrite', () => {
  it('matches a Write by content hash, and an Edit by the text it put in', () => {
    expect(matchesExpectedWrite({ sha256: sha('a') }, sha('a'), () => null)).toBe(true);
    expect(matchesExpectedWrite({ sha256: sha('a') }, sha('b'), () => 'a')).toBe(false);
    expect(matchesExpectedWrite({ contains: ['b', 'c'] }, '', () => 'abc')).toBe(true);
    expect(matchesExpectedWrite({ contains: ['b', 'z'] }, '', () => 'abc')).toBe(false);
    expect(matchesExpectedWrite({ contains: ['b'] }, '', () => null)).toBe(false);
  });
});
