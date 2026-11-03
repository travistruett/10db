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

  it('takes the newline after deleted text with it, as Claude Code does', () => {
    const env = 'A=1\nB=2\nC=3\n';
    expect(editResult('Edit', { old_string: 'B=2', new_string: '' }, env)).toBe('A=1\nC=3\n');
    // An old_string that ends in a newline, or text no newline follows, is deleted as it is.
    expect(editResult('Edit', { old_string: 'B=2\n', new_string: '' }, env)).toBe('A=1\nC=3\n');
    expect(editResult('Edit', { old_string: 'C=3\n', new_string: '' }, 'A=1\nC=3\n')).toBe('A=1\n');
    expect(editResult('Edit', { old_string: 'b', new_string: '' }, 'ab')).toBe('a');
    // With replace_all only the occurrences a newline follows go.
    expect(
      editResult('Edit', { old_string: 'B', new_string: '', replace_all: true }, 'B\nAB C\nB\n'),
    ).toBe('AB C\n');
    expect(editResult('MultiEdit', { edits: [{ old_string: 'B=2', new_string: '' }] }, env)).toBe(
      'A=1\nC=3\n',
    );
  });

  it('edits a CRLF file as LF and writes it back as CRLF, as Claude Code does', () => {
    const file = 'one\r\ntwo\r\nthree\r\n';
    expect(editResult('Edit', { old_string: 'two\nthree', new_string: '2\n3\n4' }, file)).toBe(
      'one\r\n2\r\n3\r\n4\r\n',
    );
    expect(editResult('Edit', { old_string: 'two', new_string: '' }, file)).toBe(
      'one\r\nthree\r\n',
    );
    expect(
      editResult('MultiEdit', { edits: [{ old_string: 'one\ntwo', new_string: '1\n2' }] }, file),
    ).toBe('1\r\n2\r\nthree\r\n');
    expect(
      editResult('Edit', { old_string: 'o', new_string: '0\n', replace_all: true }, 'o\r\nto\r\n'),
    ).toBe('0\r\n\r\nt0\r\n\r\n');
  });

  it('writes a file with mostly LF endings back as LF', () => {
    expect(editResult('Edit', { old_string: 'b', new_string: 'x\ny' }, 'a\nb\r\nc\n')).toBe(
      'a\nx\ny\nc\n',
    );
  });

  it('strips trailing whitespace from new_string on any file but markdown, as Claude Code does', () => {
    const edit = (file_path: string, new_string: string) => ({
      file_path,
      old_string: 'b',
      new_string,
    });
    expect(editResult('Edit', edit('/p/a.ts', 'x \t\ny  \n  \nz  '), 'a\nb\nc')).toBe(
      'a\nx\ny\n\nz\nc',
    );
    // Each line's end goes, whatever the line separator: a CRLF in new_string keeps its CR.
    expect(editResult('Edit', edit('/p/a.ts', 'x  \r\ny '), 'a b c')).toBe('a x\r\ny c');
    expect(editResult('Edit', edit('/p/a.txt', 'x '), 'a b c')).toBe('a x c');
    // Markdown (and MDX), whatever the case of the extension, keeps them: two spaces are a line break.
    expect(editResult('Edit', edit('/p/a.md', 'x  \ny '), 'a b c')).toBe('a x  \ny  c');
    expect(editResult('Edit', edit('/p/A.MDX', 'x  '), 'a b c')).toBe('a x   c');
    // The match itself is not touched: old_string finds the file's own trailing spaces.
    expect(
      editResult('Edit', { file_path: '/p/a.ts', old_string: 'a  ', new_string: 'z  ' }, 'a  b'),
    ).toBe('zb');
    expect(
      editResult(
        'MultiEdit',
        { file_path: '/p/a.ts', edits: [{ old_string: 'b', new_string: 'x  ' }] },
        'a b c',
      ),
    ).toBe('a x c');
  });

  it('counts matches without overlap, as Claude Code does', () => {
    // '==' in 'a === b' is one match to Claude Code (split), not two overlapping ones.
    expect(editResult('Edit', { old_string: '==', new_string: 'X' }, 'a === b')).toBe('a X= b');
    // Two separate matches are still refused.
    expect(editResult('Edit', { old_string: '==', new_string: 'X' }, 'a == b ==')).toBeUndefined();
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

  it('hashes a CRLF file as Claude Code writes it back', () => {
    const path = join(dir, 'crlf.txt');
    writeFileSync(path, 'a\r\nb\r\n');
    expect(allowedWriteHash('Edit', { old_string: 'a\nb', new_string: 'x\ny\nz' }, path)).toBe(
      sha('x\r\ny\r\nz\r\n'),
    );
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
