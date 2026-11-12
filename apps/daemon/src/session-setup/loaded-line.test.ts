import { describe, expect, it } from 'vitest';
import { loadedLine } from './loaded-line';

const file = (relative: string) => ({
  relative,
  source: `.claude/${relative}`,
  content: Buffer.from('x'),
  mode: 0o600,
});

describe('loadedLine', () => {
  it.each<[string, Parameters<typeof loadedLine>[0], string | null]>([
    [
      'nothing loaded or left out',
      { skills: [], plugins: [], projectFiles: [], leftOut: [] },
      null,
    ],
    [
      'every kind loaded',
      {
        skills: ['a', 'b'],
        plugins: ['superpowers@official', 'gstack@local'],
        projectFiles: [
          file('skills/x/SKILL.md'),
          file('skills/x/notes.md'),
          file('skills/y/SKILL.md'),
          file('commands/c.md'),
        ],
        leftOut: [],
      },
      'Loaded for you: 2 of your skills, the plugins superpowers and gstack, 2 project skills.',
    ],
    [
      'one plugin, one skill',
      { skills: ['a'], plugins: ['p@m'], projectFiles: [], leftOut: [] },
      'Loaded for you: 1 of your skills, the plugin p.',
    ],
    [
      'something left out',
      {
        skills: ['a'],
        plugins: [],
        projectFiles: [],
        leftOut: [
          { what: '~/x', why: 'a reason' },
          { what: 'p@m', why: 'another' },
        ],
      },
      'Loaded for you: 1 of your skills. Left out: ~/x, p@m, see the note at the end.',
    ],
    [
      'only left out',
      { skills: [], plugins: [], projectFiles: [], leftOut: [{ what: '~/x', why: 'a reason' }] },
      'Loaded for you: nothing. Left out: ~/x, see the note at the end.',
    ],
  ])('%s', (_name, input, expected) => {
    expect(loadedLine(input)).toBe(expected);
  });
});
