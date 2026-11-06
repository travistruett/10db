import { ConflictError, InvalidError } from '@10db/contracts';
import { getShape } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { must } from './conversation-fixture';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Shape spec §5.1: a conversation runs on the `plan` role's model unless the builder picks another
// the project's account offers; the pick holds for the conversation, and a live session moves to it.

const MODELS = { default: 'opus', offered: ['haiku', 'sonnet', 'opus', 'fable'] };

let f: ServiceFixture | null = null;
afterEach(async () => {
  await f?.close();
  f = null;
});

describe('a conversation’s model', () => {
  it('is the plan role’s until the builder picks one, and the view says which are offered', async () => {
    const launched: (string | null)[] = [];
    f = createServiceFixture({ models: () => MODELS, onLaunch: (m) => launched.push(m) });
    const shapeId = f.c.shape.id;
    expect(f.service.view(shapeId).models).toEqual(MODELS);
    expect(f.service.view(shapeId).shape.model).toBeNull();
    f.service.send(shapeId, 'First');
    await f.service.settled(shapeId);
    expect(f.service.chooseModel(shapeId, 'fable').model).toBe('fable');
    expect(getShape(f.c.store.db, shapeId).model).toBe('fable');
    expect(f.service.view(shapeId).shape.model).toBe('fable');
    f.service.send(shapeId, 'Second');
    await f.service.settled(shapeId);
    expect(launched).toEqual([null, 'fable']);
    const [first, second] = f.adapter.shapeSessions;
    expect(must(first, 'first').spec.model).toBe('opus');
    // The new session resumes the conversation, on the model picked.
    expect(must(second, 'second').spec.model).toBe('fable');
    expect(must(second, 'second').spec.resumeProviderSessionId).toBe('fake-shape-1');
  });

  it('goes back to the plan role’s when the pick is cleared', () => {
    f = createServiceFixture({ models: () => MODELS });
    const shapeId = f.c.shape.id;
    f.service.chooseModel(shapeId, 'fable');
    expect(f.service.chooseModel(shapeId, null).model).toBeNull();
  });

  it('lets the conversation’s agents run only on a model the account offers', async () => {
    f = createServiceFixture({
      models: () => ({ default: 'sonnet', offered: ['haiku', 'sonnet'] }),
    });
    const shapeId = f.c.shape.id;
    f.service.send(shapeId, 'First');
    await f.service.settled(shapeId);
    const { spec } = must(f.adapter.shapeSessions[0], 'a session');
    const agent = (model: string) =>
      spec.preToolUse({
        toolName: 'Agent',
        input: { subagent_type: 'code-researcher', prompt: 'x', model },
      }).decision;
    expect(agent('opus')).toBe('deny');
    expect(agent('sonnet')).toBe('allow');
  });

  it('refuses a model the project’s account does not offer', () => {
    f = createServiceFixture({ models: () => ({ default: 'opus', offered: ['opus'] }) });
    const shapeId = f.c.shape.id;
    expect(() => f?.service.chooseModel(shapeId, 'fable')).toThrow(InvalidError);
    expect(getShape(f.c.store.db, shapeId).model).toBeNull();
  });

  it('refuses a change while a turn runs, so a turn never switches model half way', async () => {
    f = createServiceFixture({ models: () => MODELS });
    const shapeId = f.c.shape.id;
    let release = (): void => undefined;
    f.adapter.shapeBehaviour = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ text: 'done' });
        };
      });
    f.service.send(shapeId, 'Long one');
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(() => f?.service.chooseModel(shapeId, 'fable')).toThrow(ConflictError);
    release();
    await f.service.settled(shapeId);
    expect(f.service.chooseModel(shapeId, 'fable').model).toBe('fable');
  });
});
