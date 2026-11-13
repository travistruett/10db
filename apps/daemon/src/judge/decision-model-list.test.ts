import { beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { DECISION_MODELS_URL } from './decision-models';
import { createDecisionModelList } from './decision-model-list';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const model = (id: string) => ({
  id,
  name: `Maker: ${id}`,
  architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
  pricing: { prompt: '0.00000002', completion: '0' },
  endpoints: ['/api/alpha/decisions'],
});

let clock: ManualClock;
let asked: string[];
let answer: () => Response | Promise<Response>;

const build = () =>
  createDecisionModelList({
    clock,
    fetch: (input) => {
      asked.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(answer());
    },
  });

/** Lets a read started behind a caller finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  clock = new ManualClock(new Date('2026-11-13T12:00:00.000Z'));
  asked = [];
  answer = () => Response.json({ data: [model('liquid/d1')] });
});

describe('the decision model list', () => {
  it('reads OpenRouter once, then answers its copy and reads again behind it once it is six hours old', async () => {
    const list = build();
    expect(await list.list()).toEqual({
      models: [expect.objectContaining({ id: 'liquid/d1' })],
      fetchedAt: '2026-11-13T12:00:00.000Z',
    });
    clock.advance(SIX_HOURS - 1);
    await list.list();
    expect(asked).toEqual([DECISION_MODELS_URL]);
    clock.advance(1);
    answer = () => Response.json({ data: [model('liquid/d1'), model('morph/reflex')] });
    // The old copy at once, without waiting on OpenRouter.
    expect((await list.list()).models.map((m) => m.id)).toEqual(['liquid/d1']);
    await settle();
    expect((await list.list()).models.map((m) => m.id)).toEqual(['liquid/d1', 'morph/reflex']);
    expect(asked).toHaveLength(2);
  });

  it('asks OpenRouter once for callers that ask together', async () => {
    const list = build();
    list.ids();
    await Promise.all([list.list(), list.list()]);
    expect(asked).toHaveLength(1);
  });

  it('keeps answering its old copy when a later read fails', async () => {
    const list = build();
    await list.list();
    clock.advance(SIX_HOURS);
    answer = () => new Response('down', { status: 503 });
    await list.list();
    await settle();
    expect((await list.list()).fetchedAt).toBe('2026-11-13T12:00:00.000Z');
  });

  it.each([
    ['an HTTP error', () => new Response('down', { status: 503 }), /503/],
    ['a body of the wrong shape', () => Response.json({ models: [] }), /model list/],
  ])('says why when the first read meets %s', async (_name, respond, why) => {
    answer = respond;
    await expect(build().list()).rejects.toThrow(why);
  });

  it('routes without waiting: none while the list is being read, the decision models once it is', async () => {
    let release: () => void = () => undefined;
    answer = () =>
      new Promise<Response>((resolve) => {
        release = () => {
          resolve(Response.json({ data: [model('liquid/d1')] }));
        };
      });
    const list = build();
    expect(list.ids()).toBeNull();
    release();
    await settle();
    expect(list.ids()).toEqual(new Set(['liquid/d1']));
    clock.advance(SIX_HOURS * 10);
    expect(list.ids()).toEqual(new Set(['liquid/d1']));
    expect(asked).toHaveLength(1);
  });

  it('reads again at most once a minute while OpenRouter fails', async () => {
    answer = () => new Response('down', { status: 503 });
    const list = build();
    list.ids();
    await settle();
    list.ids();
    list.ids();
    expect(asked).toHaveLength(1);
    clock.advance(MINUTE);
    answer = () => Response.json({ data: [model('liquid/d1')] });
    list.ids();
    await settle();
    expect(asked).toHaveLength(2);
    expect(list.ids()).toEqual(new Set(['liquid/d1']));
  });
});
