import type { ModelRowDto, ShapeModelOption } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { modelEffortDto, modelRowDto } from '../test/model-fixtures';
import { chipLabel, effortsOf, matching, splitModels } from './model-menu-options';

const rows = new Map<string, ModelRowDto>(
  [
    modelRowDto({
      model: 'claude-opus-5-5',
      name: 'Opus 5.5',
      efforts: [modelEffortDto({ effort: 'max' }), modelEffortDto({ effort: 'high' })],
    }),
    modelRowDto({
      model: 'gpt-5',
      name: 'GPT-5',
      efforts: [modelEffortDto({ effort: 'xhigh' }), modelEffortDto({ effort: 'low' })],
    }),
  ].map((row) => [row.model, row]),
);

const offered = (...pairs: [string, ShapeModelOption['tier']][]): ShapeModelOption[] =>
  pairs.map(([model, tier]) => ({ model, tier }));

describe('effortsOf', () => {
  it.each([
    { name: 'a Claude model', model: 'claude-opus-5-5', want: ['high', 'max'] },
    { name: 'a Codex model', model: 'gpt-5', want: ['low', 'xhigh'] },
    { name: 'a model the list lacks', model: 'unknown', want: [] },
    { name: 'no model', model: null, want: [] },
  ])('$name', ({ model, want }) => {
    expect(effortsOf(model, rows)).toEqual(want);
  });
});

describe('chipLabel', () => {
  it.each([
    { model: 'claude-opus-5-5', effort: 'high' as const, want: 'Opus 5.5 High' },
    { model: 'claude-opus-5-5', effort: null, want: 'Opus 5.5' },
    { model: 'not-listed-yet', effort: 'low' as const, want: 'not-listed-yet Low' },
    { model: null, effort: null, want: 'Model' },
  ])('$want', ({ model, effort, want }) => {
    expect(chipLabel(model, effort, rows)).toBe(want);
  });
});

describe('splitModels', () => {
  const six = offered(
    ['a-efficient', 'efficient'],
    ['b-balanced', 'balanced'],
    ['c-capable', 'capable'],
    ['d-frontier', 'frontier'],
    ['e-capable', 'capable'],
    ['f-unranked', null],
  );

  it('lists the strongest tiers and puts the rest behind More models, in the daemon’s order', () => {
    expect(splitModels(six, null)).toEqual({
      main: ['b-balanced', 'c-capable', 'd-frontier', 'e-capable'],
      more: ['a-efficient', 'f-unranked'],
    });
  });

  it('always lists the model in use, even a weak one', () => {
    const { main, more } = splitModels(six, 'a-efficient');
    expect(main).toContain('a-efficient');
    expect(main).toHaveLength(4);
    expect(more).not.toContain('a-efficient');
  });

  it('puts nothing behind More models when few are offered', () => {
    expect(splitModels(offered(['x', 'balanced']), 'x')).toEqual({ main: ['x'], more: [] });
  });
});

describe('matching', () => {
  it('matches the name or the id, ignoring case, and everything for an empty query', () => {
    const all = ['claude-opus-5-5', 'gpt-5'];
    expect(matching(all, 'OPUS', rows)).toEqual(['claude-opus-5-5']);
    expect(matching(all, 'gpt-', rows)).toEqual(['gpt-5']);
    expect(matching(all, '  ', rows)).toEqual(all);
    expect(matching(all, 'zzz', rows)).toEqual([]);
  });
});
