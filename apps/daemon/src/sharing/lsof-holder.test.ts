import { describe, expect, it } from 'vitest';
import { holderFromLsof, LsofUnreadableError } from './lsof-holder';

describe('holderFromLsof', () => {
  it.each<[string, string, string | null]>([
    ['one listener', 'p4242\ncnode\nf23\n', 'node (pid 4242)'],
    ['the first of two processes', 'p1\ncnode\nf3\np2\ncpython\nf4\n', 'node (pid 1)'],
    ['nothing listening', '', null],
  ])('%s', (_name, output, expected) => {
    expect(holderFromLsof(output)).toBe(expected);
  });

  it.each<[string, string]>([
    ['no pid', 'cnode\n'],
    ['a pid that is not a number', 'pabc\ncnode\n'],
    ['pid zero', 'p0\ncnode\n'],
    ['no command', 'p12\nf3\n'],
    ['garbage', 'garbage'],
  ])('throws on %s', (_name, output) => {
    expect(() => holderFromLsof(output)).toThrow(LsofUnreadableError);
  });
});
