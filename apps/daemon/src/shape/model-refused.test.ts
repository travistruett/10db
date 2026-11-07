import { listAccountModels, replaceAccountModels } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// A Plan conversation whose model the account cannot run marks it unusable on that account, so the picker
// stops offering it.

let f: ServiceFixture | null = null;
afterEach(async () => {
  await f?.close();
  f = null;
});

describe('a conversation whose model the account refuses', () => {
  it('marks the model unusable on the project’s account and tells the builder', async () => {
    f = createServiceFixture({ launchId: (model) => `us.anthropic.${model}` });
    const shapeId = f.c.shape.id;
    const accountId = f.c.project.accountId;
    f.state.write((ctx) =>
      replaceAccountModels(ctx, accountId, [
        {
          model: 'claude-opus-5-5',
          family: null,
          launchId: 'us.anthropic.claude-opus-5-5',
          efforts: [],
          inputPrice: null,
          outputPrice: null,
        },
      ]),
    );
    f.adapter.shapeBehaviour = () => Promise.resolve({ refusedModel: true });
    f.service.send(shapeId, 'First');
    await f.service.settled(shapeId);

    expect(listAccountModels(f.c.store.db, accountId)).toMatchObject([
      { model: 'claude-opus-5-5', unusable: true },
    ]);
    expect(
      f.service
        .view(shapeId)
        .messages.map((m) => m.body)
        .join('\n'),
    ).toMatch(/cannot run the model us\.anthropic\.claude-opus-5-5/);
  });
});
