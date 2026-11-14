import { describe, expect, it } from 'vitest';
import { DecisionModelDto } from './decision-models';

describe('DecisionModelDto', () => {
  it('reads a model from before its measured numbers existed with null numbers and sources', () => {
    const model = DecisionModelDto.parse({
      id: 'maker/model',
      name: 'Model',
      maker: 'Maker',
      latest: false,
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      cantCall: null,
    });
    expect(model).toMatchObject({
      costPerMillionUsd: null,
      secondsPerDecision: null,
      costSource: null,
      timeSource: null,
    });
  });
});
