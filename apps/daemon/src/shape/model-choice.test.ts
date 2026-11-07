import { AccountKind, ConflictError, InvalidError } from '@10db/contracts';
import { getShape } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { must } from './conversation-fixture';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Shape spec §5.1: a conversation runs on the `plan` role's model unless the builder picks another
// the project's account offers; the pick holds for the conversation, and a live session moves to it.

const MODELS = {
  default: 'claude-opus-5-5',
  offered: [
    { model: 'claude-haiku-5-5', tier: 'fast' as const },
    { model: 'claude-sonnet-5-5', tier: 'balanced' as const },
    { model: 'claude-opus-5-5', tier: 'strongest' as const },
    { model: 'house-model', tier: null },
  ],
};

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
    expect(f.service.chooseModel(shapeId, 'claude-sonnet-5-5').model).toBe('claude-sonnet-5-5');
    expect(getShape(f.c.store.db, shapeId).model).toBe('claude-sonnet-5-5');
    expect(f.service.view(shapeId).shape.model).toBe('claude-sonnet-5-5');
    f.service.send(shapeId, 'Second');
    await f.service.settled(shapeId);
    expect(launched).toEqual([null, 'claude-sonnet-5-5']);
    const [first, second] = f.adapter.shapeSessions;
    expect(must(first, 'first').spec.model).toBe('claude-opus-5-5');
    // The new session resumes the conversation, on the model picked.
    expect(must(second, 'second').spec.model).toBe('claude-sonnet-5-5');
    expect(must(second, 'second').spec.resumeProviderSessionId).toBe('fake-shape-1');
  });

  it('goes back to the plan role’s when the pick is cleared', () => {
    f = createServiceFixture({ models: () => MODELS });
    const shapeId = f.c.shape.id;
    f.service.chooseModel(shapeId, 'claude-opus-5-5');
    expect(f.service.chooseModel(shapeId, null).model).toBeNull();
  });

  it('lets a model the account lists without a tier be chosen, like any other', () => {
    f = createServiceFixture({ models: () => MODELS });
    expect(f.service.chooseModel(f.c.shape.id, 'house-model').model).toBe('house-model');
  });

  it.each([
    { kind: AccountKind.ClaudeSubscription, sonnet: 'allow', opus: 'allow', gpt: 'deny' },
    { kind: AccountKind.Bedrock, sonnet: 'deny', opus: 'deny', gpt: 'deny' },
  ] as const)(
    'lets the conversation’s agents name an alias only where $kind takes them',
    async ({ kind, sonnet, opus, gpt }) => {
      f = createServiceFixture({ models: () => MODELS, accountKind: kind });
      const shapeId = f.c.shape.id;
      f.service.send(shapeId, 'First');
      await f.service.settled(shapeId);
      const { spec } = must(f.adapter.shapeSessions[0], 'a session');
      const agent = (model: string) =>
        spec.preToolUse({
          toolName: 'Agent',
          input: { subagent_type: 'code-researcher', prompt: 'x', model },
        }).decision;
      expect([agent('sonnet'), agent('opus'), agent('gpt-5.6-sol')]).toEqual([sonnet, opus, gpt]);
      expect(spec.systemPrompt).toContain(
        kind === AccountKind.Bedrock ? "session's model" : '"opus"',
      );
    },
  );

  it('refuses a model the project’s account does not offer', () => {
    f = createServiceFixture({
      models: () => ({
        default: 'claude-opus-5-5',
        offered: [{ model: 'claude-opus-5-5', tier: 'strongest' }],
      }),
    });
    const shapeId = f.c.shape.id;
    expect(() => f?.service.chooseModel(shapeId, 'claude-fable-5-1')).toThrow(InvalidError);
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
    expect(() => f?.service.chooseModel(shapeId, 'claude-opus-5-5')).toThrow(ConflictError);
    release();
    await f.service.settled(shapeId);
    expect(f.service.chooseModel(shapeId, 'claude-opus-5-5').model).toBe('claude-opus-5-5');
  });
});
