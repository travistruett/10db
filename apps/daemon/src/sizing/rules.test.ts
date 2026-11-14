import { describe, expect, it } from 'vitest';
import { Rigor, TaskKindSource, type KindDto, type TaskKind } from '@10db/contracts';
import { sizeByRules } from './rules';

const kinds: readonly Pick<KindDto, 'key' | 'impliedBy'>[] = [
  { key: 'migration', impliedBy: ['migrations'] },
  { key: 'dependency', impliedBy: ['deps', 'lockfile'] },
  { key: 'docs', impliedBy: [] },
  { key: 'security', impliedBy: [] },
];
const kind = (key: string, source: TaskKind['source']): TaskKind => ({ key, source });

describe('sizeByRules', () => {
  it.each([
    {
      name: 'an area the kind is implied by adds it, from the rules',
      task: { areas: ['app', 'migrations'], kinds: [], kindsOff: [] },
      want: [kind('migration', 'rules')],
    },
    {
      name: "either of a kind's names implies it",
      task: { areas: ['lockfile'], kinds: [], kindsOff: [] },
      want: [kind('dependency', 'rules')],
    },
    {
      name: 'both kinds when both are implied',
      task: { areas: ['migrations', 'deps'], kinds: [], kindsOff: [] },
      want: [kind('migration', 'rules'), kind('dependency', 'rules')],
    },
    {
      name: 'no matching area adds nothing',
      task: { areas: ['app'], kinds: [], kindsOff: [] },
      want: [],
    },
    {
      name: 'a kind the builder took off never returns',
      task: { areas: ['migrations'], kinds: [], kindsOff: ['migration'] },
      want: [],
    },
    {
      name: 'a kind the builder gave stays as theirs, and is not added twice',
      task: {
        areas: ['migrations'],
        kinds: [kind('migration', TaskKindSource.Builder)],
        kindsOff: [],
      },
      want: [kind('migration', 'builder')],
    },
    {
      name: 'builder and agent kinds stay with no area at all',
      task: {
        areas: [],
        kinds: [kind('docs', TaskKindSource.Builder), kind('security', TaskKindSource.Agent)],
        kindsOff: [],
      },
      want: [kind('docs', 'builder'), kind('security', 'agent')],
    },
    {
      name: 'a rules kind no longer implied is dropped',
      task: { areas: ['app'], kinds: [kind('migration', TaskKindSource.Rules)], kindsOff: [] },
      want: [],
    },
    {
      name: 'a judge kind is dropped when no judged answer is given',
      task: { areas: ['app'], kinds: [kind('docs', TaskKindSource.Judge)], kindsOff: [] },
      want: [],
    },
  ])('$name', ({ task, want }) => {
    expect(sizeByRules({ task, kinds }).kinds).toEqual(want);
  });

  it.each([
    {
      name: 'the judged kinds join the rules',
      task: { areas: ['migrations'], kinds: [], kindsOff: [] },
      judged: { kinds: [kind('security', TaskKindSource.Judge)] },
      want: [kind('migration', 'rules'), kind('security', 'judge')],
    },
    {
      name: 'a kind both implied and judged is the rules',
      task: { areas: ['migrations'], kinds: [], kindsOff: [] },
      judged: { kinds: [kind('migration', TaskKindSource.Judge)] },
      want: [kind('migration', 'rules')],
    },
    {
      name: 'a judged kind the builder took off is not added',
      task: { areas: [], kinds: [], kindsOff: ['docs'] },
      judged: { kinds: [kind('docs', TaskKindSource.Judge)] },
      want: [],
    },
    {
      name: "a judged kind the builder already gave stays the builder's",
      task: { areas: [], kinds: [kind('docs', TaskKindSource.Builder)], kindsOff: [] },
      judged: { kinds: [kind('docs', TaskKindSource.Judge)] },
      want: [kind('docs', 'builder')],
    },
    {
      name: 'a judged kind no kind has is dropped',
      task: { areas: [], kinds: [], kindsOff: [] },
      judged: { kinds: [kind('gone', TaskKindSource.Judge)] },
      want: [],
    },
  ])('$name', ({ task, judged, want }) => {
    expect(sizeByRules({ task, kinds, judged }).kinds).toEqual(want);
  });

  it('stores no rigor of its own: with nothing judged there is none', () => {
    const task = { areas: ['migrations'], kinds: [], kindsOff: [] };
    expect(sizeByRules({ task, kinds }).rigor).toBeUndefined();
  });

  it("passes the judge's rigor on as the judge's", () => {
    const task = { areas: [], kinds: [], kindsOff: [] };
    const judged = {
      kinds: [],
      rigor: { value: Rigor.Careful, reason: 'judged Careful (0.86)' },
    };
    expect(sizeByRules({ task, kinds, judged }).rigor).toEqual({
      value: 'careful',
      source: 'judge',
      reason: 'judged Careful (0.86)',
    });
  });
});
