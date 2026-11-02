import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedWriteFor, allowedWriteHash, allowedWritesIn, editResult } from './expected-write';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('editResult', () => {
  it('is the whole content for a Write', () => {
    expect(editResult('Write', { content: 'hello' }, 'old')).toBe('hello');
  });

  it('applies an Edit as Claude Code does: the one occurrence, or every one with replace_all', () => {
    expect(editResult('Edit', { old_string: 'b', new_string: 'X' }, 'abc')).toBe('aXc');
    expect(editResult('Edit', { old_string: 'b', new_string: '$&' }, 'abc')).toBe('a$&c');
    expect(editResult('Edit', { old_string: 'b', new_string: '' }, 'abc')).toBe('ac');
    expect(
      editResult('Edit', { old_string: 'b', new_string: 'X', replace_all: true }, 'abcb'),
    ).toBe('aXcX');
    expect(editResult('Edit', { old_string: '', new_string: 'new' }, null)).toBe('new');
  });

  it('applies a MultiEdit one edit after another', () => {
    expect(
      editResult(
        'MultiEdit',
        {
          edits: [
            { old_string: 'a', new_string: 'b' },
            { old_string: 'bb', new_string: 'c' },
          ],
        },
        'ab',
      ),
    ).toBe('c');
  });

  it.each([
    ['a NotebookEdit', 'NotebookEdit', { new_source: 'x' }, '{}'],
    ['an Edit whose text is not there', 'Edit', { old_string: 'z', new_string: 'y' }, 'abc'],
    ['an Edit whose text is there twice', 'Edit', { old_string: 'a', new_string: 'y' }, 'aa'],
    ['an Edit of a missing file', 'Edit', { old_string: 'a', new_string: 'y' }, null],
    [
      'an Edit that creates a file that has content',
      'Edit',
      { old_string: '', new_string: 'y' },
      'a',
    ],
    ['a Write with no content', 'Write', {}, 'a'],
    ['a MultiEdit with a part that is no edit', 'MultiEdit', { edits: [1] }, 'a'],
  ])('is unknown for %s', (_name, tool, input, current) => {
    expect(editResult(tool, input, current)).toBeUndefined();
  });
});

describe('allowedWriteHash', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), '10db-expected-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('hashes the file the call leaves, from the file as it is now', () => {
    const path = join(dir, 'a.json');
    writeFileSync(path, '{"a":1}');
    expect(allowedWriteHash('Edit', { old_string: '1', new_string: '2' }, path)).toBe(
      sha('{"a":2}'),
    );
    expect(allowedWriteHash('Write', { content: 'x' }, join(dir, 'new'))).toBe(sha('x'));
  });

  it('is unknown for a relative path, or a call that would fail', () => {
    expect(allowedWriteHash('Write', { content: 'x' }, 'a.json')).toBeUndefined();
    expect(
      allowedWriteHash('Edit', { old_string: 'z', new_string: 'y' }, join(dir, 'gone')),
    ).toBeUndefined();
  });
});

describe('allowedWriteFor', () => {
  const hash = sha('x');

  it("is the lane's own recorded hash", () => {
    const detail = { exactWrite: true, allowedWrites: { A: hash, B: sha('y') } };
    expect(allowedWriteFor(detail, 'A')).toBe(hash);
    expect(allowedWriteFor(detail, 'B')).toBe(sha('y'));
  });

  it('is null for an exact card with nothing recorded for the lane, and undefined for an older card', () => {
    expect(allowedWriteFor({ exactWrite: true, allowedWrites: { A: hash } }, 'B')).toBeNull();
    expect(allowedWriteFor({ exactWrite: true, allowedWrites: { A: 'nope' } }, 'A')).toBeNull();
    expect(allowedWriteFor({ allowedWrites: { A: hash } }, 'A')).toBeUndefined();
    expect(allowedWriteFor(null, 'A')).toBeUndefined();
  });

  it('reads only well-formed entries', () => {
    expect(allowedWritesIn({ allowedWrites: { A: hash, B: 1, C: 'short' } })).toEqual({ A: hash });
    expect(allowedWritesIn({ allowedWrites: [hash] })).toEqual({});
  });
});
