import { beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { DECISION_MODELS_URL } from './decision-models';
import { createDecisionModelList, DECISION_MODELS_TTL_MS } from './decision-model-list';

const model = (id: string) => ({
  id,
  name: `Maker: ${id}`,
  architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
  pricing: { prompt: '0.00000002', completion: '0' },
  endpoints: ['/api/alpha/decisions'],
});

let clock: ManualClock;
let asked: string[];
let answer: () => Response;

const build = () =>
  createDecisionModelList({
    clock,
    fetch: (input) => {
      asked.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(answer());
    },
  });

beforeEach(() => {
  clock = new ManualClock(new Date('2026-11-13T12:00:00.000Z'));
  asked = [];
  answer = () => Response.json({ data: [model('liquid/d1')] });
});

describe('the decision model list', () => {
  it('reads OpenRouter once and answers from its copy until it is a few hours old', async () => {
    const list = build();
    const first = await list.list();
    expect(first).toEqual({
      models: [expect.objectContaining({ id: 'liquid/d1' })],
      fetchedAt: '2026-11-13T12:00:00.000Z',
    });
    clock.advance(DECISION_MODELS_TTL_MS - 1);
    await list.list();
    expect(asked).toEqual([DECISION_MODELS_URL]);
    clock.advance(1);
    answer = () => Response.json({ data: [model('liquid/d1'), model('morph/reflex')] });
    expect((await list.list()).models.map((m) => m.id)).toEqual(['liquid/d1', 'morph/reflex']);
    expect(asked).toHaveLength(2);
  });

  it('asks OpenRouter once for callers that ask together', async () => {
    const list = build();
    await Promise.all([list.list(), list.list(), list.ids()]);
    expect(asked).toHaveLength(1);
  });

  it('keeps answering its old copy when a later read fails', async () => {
    const list = build();
    await list.list();
    clock.advance(DECISION_MODELS_TTL_MS);
    answer = () => new Response('down', { status: 503 });
    expect((await list.list()).fetchedAt).toBe('2026-11-13T12:00:00.000Z');
  });

  it.each([
    ['an HTTP error', () => new Response('down', { status: 503 }), /503/],
    ['a body of the wrong shape', () => Response.json({ models: [] }), /model list/],
  ])('says why when the first read meets %s', async (_name, respond, why) => {
    answer = respond;
    await expect(build().list()).rejects.toThrow(why);
  });

  it('names the decision models for routing, and none when the list cannot be read', async () => {
    expect(await build().ids()).toEqual(new Set(['liquid/d1']));
    answer = () => new Response('down', { status: 503 });
    expect(await build().ids()).toBeNull();
  });

  it('routes on its copy however old, without asking OpenRouter again', async () => {
    const list = build();
    await list.ids();
    clock.advance(DECISION_MODELS_TTL_MS * 10);
    expect(await list.ids()).toEqual(new Set(['liquid/d1']));
    expect(asked).toHaveLength(1);
  });
});
