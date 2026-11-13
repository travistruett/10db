import { UpstreamError, type DecisionModelDto, type DecisionModelListDto } from '@10db/contracts';
import { createTestStore, insertJudgeCall, type JudgeCallInput } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { unavailableKeychain } from '../environment';
import { createJudgeServices } from './judge-services';

const DAY = 24 * 60 * 60 * 1000;

let state: StateStore;
let close: () => void;
let clock: ManualClock;

beforeEach(() => {
  clock = new ManualClock(new Date('2026-11-13T12:00:00.000Z'));
  const test = createTestStore(() => clock.now());
  close = test.close;
  state = createStateStore(test.store, createEventBus());
});
afterEach(() => {
  close();
});

const model = (id: string, inputUsdPerMillion: number): DecisionModelDto => ({
  id,
  name: id,
  maker: 'Acme',
  latest: false,
  inputUsdPerMillion,
  outputUsdPerMillion: 0,
  cantCall: null,
  costPerMillionUsd: null,
  secondsPerDecision: null,
  costSource: null,
  timeSource: null,
});

const frozen = (models: DecisionModelDto[]): DecisionModelListDto => {
  const own = models.map((m) => Object.freeze({ ...m }));
  Object.freeze(own);
  return Object.freeze({ fetchedAt: '2026-11-13T11:00:00.000Z', models: own });
};

function services(list: DecisionModelListDto, over: { off?: boolean } = {}) {
  return createJudgeServices({
    state,
    keychain: unavailableKeychain,
    judge: { test: () => Promise.reject(new Error('not used')) },
    models: { list: () => Promise.resolve(list) },
    off: over.off ?? false,
    clock,
  });
}

const call = (over: Partial<JudgeCallInput> = {}): JudgeCallInput => ({
  decision: 'review_size',
  model: 'acme/d1',
  state: 's',
  question: 'q',
  answer: 'skip',
  confidence: 0.9,
  outcome: 'acted',
  latencyMs: 250,
  costUsd: 0.000002,
  workstreamId: null,
  taskId: null,
  ...over,
});
const log = (over: Partial<JudgeCallInput> = {}) => {
  state.write((ctx) => insertJudgeCall(ctx, call(over)));
};

describe('listDecisionModels', () => {
  it('answers a new list each time and never changes the one it was given', async () => {
    const held = frozen([model('acme/d1', 0.042)]);
    log();
    const api = services(held);
    const first = await api.listDecisionModels();
    const second = await api.listDecisionModels();
    expect(first.models[0]).toMatchObject({ costSource: 'your_calls' });
    expect(first).not.toBe(held);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(held.models[0]?.costSource).toBeNull();
  });

  it('counts the last 30 days of calls on the injected clock, and no older one', async () => {
    log({ costUsd: 9, latencyMs: 9000 });
    clock.advance(31 * DAY);
    log({ costUsd: 0.000002, latencyMs: 250 });
    const api = services(frozen([model('acme/d1', 0.042)]));
    const { models } = await api.listDecisionModels();
    expect(models[0]).toMatchObject({ costPerMillionUsd: 2, secondsPerDecision: 0.25 });

    const stats = api.judgeDecisionStats();
    expect(stats.since).toBe(new Date(clock.now().getTime() - 30 * DAY).toISOString());
    expect(stats.decisions).toEqual([expect.objectContaining({ calls: 1 })]);
  });

  it('prices a call the old one left out only by the model’s price', async () => {
    log({ costUsd: 9 });
    clock.advance(31 * DAY);
    const api = services(frozen([model('acme/d1', 0.042)]));
    const { models } = await api.listDecisionModels();
    expect(models[0]).toMatchObject({ costSource: 'assumed', timeSource: null });
  });

  it('gives a model that charges nothing, with answered calls that logged no cost, a cost of 0 from your calls', async () => {
    log({ model: 'acme/free:free', costUsd: null });
    const api = services(frozen([model('acme/free:free', 0)]));
    const { models } = await api.listDecisionModels();
    expect(models[0]).toMatchObject({
      costPerMillionUsd: 0,
      costSource: 'your_calls',
      timeSource: 'your_calls',
    });
  });

  it('reports a database fault as itself, not as OpenRouter’s', async () => {
    const api = services(frozen([model('acme/d1', 0.042)]));
    close();
    const failure = await api.listDecisionModels().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UpstreamError);
  });

  it('reports an unreadable list as OpenRouter’s', async () => {
    const api = createJudgeServices({
      state,
      keychain: unavailableKeychain,
      judge: { test: () => Promise.reject(new Error('not used')) },
      models: { list: () => Promise.reject(new Error('503')) },
      off: false,
      clock,
    });
    await expect(api.listDecisionModels()).rejects.toBeInstanceOf(UpstreamError);
  });
});
