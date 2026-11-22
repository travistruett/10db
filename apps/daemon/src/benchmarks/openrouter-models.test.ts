import { describe, expect, it } from 'vitest';
import { toolModelsOf } from './openrouter-client';

// The shape of OpenRouter's models API: prices are per-token strings, a router's price is "-1".
const BODY = {
  data: [
    {
      id: 'openai/gpt-5.1',
      supported_parameters: ['tools', 'temperature'],
      pricing: { prompt: '0.00000125', completion: '0.00001' },
      architecture: { input_modalities: ['text', 'image'] },
    },
    {
      id: 'vendor/no-tools',
      supported_parameters: ['temperature'],
      pricing: { prompt: '0.000001', completion: '0.000002' },
    },
    {
      id: 'openrouter/auto',
      supported_parameters: ['tools'],
      pricing: { prompt: '-1', completion: '-1' },
    },
    {
      id: 'vendor/free:free',
      supported_parameters: ['tools'],
      pricing: { prompt: '0', completion: '0' },
    },
  ],
};

describe('toolModelsOf', () => {
  it('keeps tool-capable models with their per-million prices and drops routers', () => {
    expect(toolModelsOf(BODY)).toEqual([
      {
        id: 'openai/gpt-5.1',
        inputPrice: 1.25,
        outputPrice: 10,
        inputModalities: ['text', 'image'],
      },
      { id: 'vendor/free:free', inputPrice: 0, outputPrice: 0, inputModalities: [] },
    ]);
  });

  it('answers null for a body that is not a model list', () => {
    expect(toolModelsOf({ error: 'nope' })).toBeNull();
  });
});
