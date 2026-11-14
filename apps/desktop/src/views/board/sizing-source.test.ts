import { Rigor, type TaskDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { kindBadge, rigorBadge, rigorSourceLine } from './sizing-source';

type Sized = Pick<
  TaskDto,
  'effectiveRigor' | 'effectiveRigorSource' | 'effectiveRigorReason' | 'sizedByRules'
>;
const task = (over: Partial<Sized>): Sized => ({
  effectiveRigor: Rigor.Careful,
  effectiveRigorSource: 'judge',
  effectiveRigorReason: null,
  sizedByRules: false,
  ...over,
});

describe('rigorBadge', () => {
  it.each([
    {
      name: 'judged, with the judge’s reason',
      over: { effectiveRigorSource: 'judge', effectiveRigorReason: 'judged Careful (0.86)' },
      want: { label: 'Careful · judged', tooltip: 'judged Careful (0.86)' },
    },
    {
      name: 'raised by the rules, with the kinds that hold it',
      over: { effectiveRigorSource: 'rules', effectiveRigorReason: 'at least Careful: migration' },
      want: { label: 'Careful · rules', tooltip: 'at least Careful: migration' },
    },
    {
      name: 'an agent’s, with its reason',
      over: { effectiveRigorSource: 'agent', effectiveRigorReason: 'touches the contracts' },
      want: { label: 'Careful · agent', tooltip: 'touches the contracts' },
    },
    {
      name: 'an agent’s, with none',
      over: { effectiveRigorSource: 'agent' },
      want: { label: 'Careful · agent', tooltip: 'Rigor an agent set' },
    },
    {
      name: 'the builder’s, even while no judge answer has landed',
      over: { effectiveRigorSource: 'builder', sizedByRules: true },
      want: { label: 'Careful · you', tooltip: 'Rigor you set' },
    },
    {
      name: 'the judge’s with no reason, sized by rules',
      over: { effectiveRigorSource: 'judge', sizedByRules: true },
      want: { label: 'Careful · judged', tooltip: 'Sized by rules' },
    },
  ] as const)('$name', ({ over, want }) => {
    expect(rigorBadge(task(over), Rigor.Standard)).toEqual(want);
  });

  it('says nothing for the project’s own default', () => {
    expect(
      rigorBadge(
        task({ effectiveRigorSource: 'default', effectiveRigor: Rigor.Standard }),
        Rigor.Standard,
      ),
    ).toBeNull();
  });

  it('shows a default-sourced rigor that differs from the project’s, with no source word', () => {
    expect(
      rigorBadge(
        task({ effectiveRigorSource: 'default', effectiveRigor: Rigor.Light, sizedByRules: true }),
        Rigor.Standard,
      ),
    ).toEqual({ label: 'Light', tooltip: 'Sized by rules' });
  });
});

describe('rigorSourceLine', () => {
  it.each([
    {
      name: 'the judge’s own words',
      over: { effectiveRigorSource: 'judge', effectiveRigorReason: 'judged Careful (0.86)' },
      want: 'Judged Careful (0.86)',
    },
    {
      name: 'what the rules did',
      over: { effectiveRigorSource: 'rules', effectiveRigorReason: 'at least Careful: migration' },
      want: 'At least Careful: migration',
    },
    {
      name: 'an agent’s reason, saying it is an agent’s',
      over: { effectiveRigorSource: 'agent', effectiveRigorReason: 'touches the contracts' },
      want: 'An agent: touches the contracts',
    },
    { name: 'the builder', over: { effectiveRigorSource: 'builder' }, want: 'Rigor you set' },
    {
      name: 'the default while only rules sized the task',
      over: { effectiveRigorSource: 'default', sizedByRules: true },
      want: 'Sized by rules',
    },
    {
      name: 'the default once a judge answer landed',
      over: { effectiveRigorSource: 'default', sizedByRules: false },
      want: 'The project’s default',
    },
  ] as const)('$name', ({ over, want }) => {
    expect(rigorSourceLine(task(over))).toBe(want);
  });
});

describe('kindBadge', () => {
  it.each([
    { source: 'judge', word: 'judged', tooltip: 'The judge said the task touches it' },
    { source: 'rules', word: 'rules', tooltip: 'The task’s areas imply it' },
    { source: 'agent', word: 'agent', tooltip: 'An agent gave the task this kind' },
    { source: 'builder', word: 'you', tooltip: 'You set this kind' },
  ] as const)('a $source kind reads "$word"', ({ source, word, tooltip }) => {
    expect(kindBadge('Docs', source)).toEqual({ label: `Docs · ${word}`, tooltip });
  });
});
