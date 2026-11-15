import { describe, expect, it } from 'vitest';
import { readSkillVersion } from './skill-version';

describe('readSkillVersion', () => {
  const rows: { name: string; text: string | null; expected: string | null }[] = [
    { name: 'twelve hex digits and a newline', text: 'abcdef012345\n', expected: 'abcdef012345' },
    { name: 'a version with a newline inside', text: 'abc\ndef', expected: null },
    { name: 'uppercase digits', text: 'ABCDEF012345', expected: null },
    { name: 'too short', text: 'abc123', expected: null },
    { name: 'an empty file', text: '', expected: null },
    { name: 'no file', text: null, expected: null },
  ];
  it.each(rows)('reads $name as $expected', ({ text, expected }) => {
    const readFile = (): string => {
      if (text === null) throw new Error('ENOENT');
      return text;
    };
    expect(readSkillVersion(readFile)).toBe(expected);
  });
});
