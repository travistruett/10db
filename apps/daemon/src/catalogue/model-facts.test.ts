import { AccountKind, mintId, ModelProfileDto, ModelStatus, ModelTier } from '@10db/contracts';
import type { OpenRouterMeasure } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { effortFacts, modelSpeed, SPEED_STALE_MS, speedProviderFor } from './model-facts';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const FRESH = '2026-11-13T06:00:00.000Z';
const STALE = new Date(NOW.getTime() - SPEED_STALE_MS - 1000).toISOString();
const AT = '2026-11-06T10:00:00.000Z';

const aaProfile = (over: {
  intelligence?: number | null;
  speed?: number | null;
  cost?: number | null;
}): ModelProfileDto =>
  ModelProfileDto.parse({
    id: mintId('ModelProfile'),
    provider: 'claude',
    model: 'claude-opus-5-5',
    effort: 'max',
    aaSlug: null,
    scores: { intelligence: over.intelligence ?? null },
    costPerTaskUsd: over.cost ?? null,
    outputTokensPerSecond: over.speed ?? null,
    source: 'aa',
    indexVersion: null,
    measuredAt: null,
    enabled: false,
    maker: 'anthropic',
    family: 'claude-opus',
    tier: ModelTier.Capable,
    status: ModelStatus.Current,
    inputPrice: 5,
    outputPrice: 25,
    releaseDate: '2026-10-01',
    stepsRun: 0,
    firstPassSteps: 0,
    escalations: 0,
    createdAt: AT,
    updatedAt: AT,
  });

const NO_NUMBERS = {
  intelligence: null,
  coding: null,
  agentic: null,
  accuracy: null,
  costPerTaskUsd: null,
  tokensPerSecond: null,
  latencyMs: null,
};
const relayed = (over: Partial<OpenRouterMeasure>): OpenRouterMeasure => ({
  ...NO_NUMBERS,
  id: 'anthropic/claude-opus-5.5',
  kind: 'score_aa',
  key: '',
  measuredAt: FRESH,
  ...over,
});
const speed = (provider: string, tokensPerSecond: number | null, measuredAt = FRESH) =>
  relayed({ kind: 'speed', key: provider, tokensPerSecond, latencyMs: 300, measuredAt });
const eval_ = relayed({
  kind: 'score_openrouter',
  key: 'gpqa',
  accuracy: 0.9,
  costPerTaskUsd: 0.4,
});

describe('effortFacts: scores', () => {
  it.each([
    {
      name: 'AA present wins over a relayed score',
      aa: { intelligence: 40 },
      isMax: true,
      rows: [relayed({ intelligence: 55 })],
      expected: { intelligence: 40 },
      source: 'aa',
    },
    {
      name: 'AA absent on Max takes AA via OpenRouter',
      aa: {},
      isMax: true,
      rows: [relayed({ intelligence: 55 })],
      expected: { intelligence: 55 },
      source: 'aa_via_openrouter',
    },
    {
      name: 'AA absent on another effort stays null',
      aa: {},
      isMax: false,
      rows: [relayed({ intelligence: 55 })],
      expected: { intelligence: null },
      source: null,
    },
    {
      name: 'a model with no relayed score shows none',
      aa: {},
      isMax: true,
      rows: [],
      expected: { intelligence: null },
      source: null,
    },
  ])('$name', ({ aa, isMax, rows, expected, source }) => {
    const facts = effortFacts({
      aa: aaProfile(aa),
      isMax,
      openRouter: rows,
      provider: null,
      now: NOW,
      costPerTaskUsd: null,
    });
    expect(facts).toMatchObject(expected);
    expect(facts.sources.intelligence).toBe(source);
  });

  it('takes Coding and Agentic from OpenRouter on Max, and only there', () => {
    const rows = [relayed({ coding: 31, agentic: 22 })];
    const max = effortFacts({
      aa: aaProfile({}),
      isMax: true,
      openRouter: rows,
      provider: null,
      now: NOW,
      costPerTaskUsd: null,
    });
    const other = effortFacts({
      aa: aaProfile({}),
      isMax: false,
      openRouter: rows,
      provider: null,
      now: NOW,
      costPerTaskUsd: null,
    });
    expect(max).toMatchObject({ coding: 31, agentic: 22 });
    expect(max.sources).toMatchObject({
      coding: 'aa_via_openrouter',
      agentic: 'aa_via_openrouter',
    });
    expect(other).toMatchObject({ coding: null, agentic: null });
  });

  it('never takes cost per task from OpenRouter, and names AA when it has one', () => {
    const none = effortFacts({
      aa: aaProfile({}),
      isMax: true,
      openRouter: [eval_],
      provider: null,
      now: NOW,
      costPerTaskUsd: null,
    });
    expect(none.costPerTaskUsd).toBeNull();
    expect(none.sources.costPerTask).toBeNull();
    const aa = effortFacts({
      aa: aaProfile({ cost: 1.5 }),
      isMax: true,
      openRouter: [eval_],
      provider: null,
      now: NOW,
      costPerTaskUsd: 1.5,
    });
    expect(aa.costPerTaskUsd).toBe(1.5);
    expect(aa.sources.costPerTask).toBe('aa');
  });
});

describe('modelSpeed', () => {
  it.each([
    {
      name: 'the p50 on the account provider',
      rows: [speed('Anthropic', 80), speed('Other', 20)],
      provider: 'Anthropic',
      aa: 50,
      expected: { tokensPerSecond: 80, source: 'openrouter', provider: 'Anthropic' },
    },
    {
      name: 'a provider with a null throughput falls to the median of the others',
      rows: [speed('Anthropic', null), speed('A', 10), speed('B', 30), speed('C', 20)],
      provider: 'Anthropic',
      aa: 50,
      expected: { tokensPerSecond: 20, source: 'openrouter', provider: null },
    },
    {
      name: 'no account provider takes the median of two',
      rows: [speed('A', 10), speed('B', 30)],
      provider: null,
      aa: 50,
      expected: { tokensPerSecond: 20, source: 'openrouter', provider: null },
    },
    {
      name: 'a stale row is ignored',
      rows: [speed('Anthropic', 99, STALE)],
      provider: 'Anthropic',
      aa: 50,
      expected: { tokensPerSecond: 50, source: 'aa', provider: null },
    },
    {
      name: 'no OpenRouter speed falls to AA',
      rows: [],
      provider: 'Anthropic',
      aa: 50,
      expected: { tokensPerSecond: 50, source: 'aa', provider: null },
    },
    {
      name: 'nothing anywhere is null, never zero',
      rows: [speed('Anthropic', null)],
      provider: 'Anthropic',
      aa: null,
      expected: { tokensPerSecond: null, source: null, provider: null },
    },
  ])('$name', ({ rows, provider, aa, expected }) => {
    expect(modelSpeed({ openRouter: rows, provider, aaSpeed: aa, now: NOW })).toEqual(expected);
  });

  it('reads the same speed on every effort of a model', () => {
    const rows = [speed('Anthropic', 80)];
    const args = { openRouter: rows, provider: 'Anthropic', now: NOW, costPerTaskUsd: null };
    const a = effortFacts({ aa: aaProfile({ speed: 5 }), isMax: true, ...args });
    const b = effortFacts({ aa: aaProfile({ speed: 7 }), isMax: false, ...args });
    expect([a.outputTokensPerSecond, a.speedProvider]).toEqual([80, 'Anthropic']);
    expect([b.outputTokensPerSecond, b.speedProvider]).toEqual([80, 'Anthropic']);
  });
});

describe('speedProviderFor', () => {
  it.each([
    [AccountKind.ClaudeSubscription, 'Anthropic'],
    [AccountKind.AnthropicApiKey, 'Anthropic'],
    [AccountKind.Bedrock, 'Amazon Bedrock'],
    [AccountKind.CodexSignin, 'OpenAI'],
    [AccountKind.OpenaiApiKey, 'OpenAI'],
    [AccountKind.Gateway, null],
    [AccountKind.OpenRouter, null],
  ])('%s -> %s', (kind, expected) => {
    expect(speedProviderFor(kind)).toBe(expected);
  });
});
