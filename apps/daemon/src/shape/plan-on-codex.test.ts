import { AccountKind, ShapeOrigin, StartShapeInput } from '@10db/contracts';
import { schema, shapeConversation } from '@10db/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { must } from './conversation-fixture';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Sessions spec S8, §5.5: Plan runs on a ChatGPT account as on Claude, on the explore profile, and its
// view says what Codex lacks: the research and review agents.

const MODELS = {
  default: 'gpt-5.6-sol',
  offered: [
    { model: 'gpt-5.6-sol', tier: 'capable' as const },
    { model: 'gpt-5.6-mini', tier: 'efficient' as const },
  ],
};

let f: ServiceFixture;
afterEach(async () => {
  await f.close();
});

describe('Plan on a ChatGPT account', () => {
  it('starts, takes a message, a model choice and Propose, on an explore session with no agents', async () => {
    f = createServiceFixture({ accountKind: AccountKind.CodexSignin, models: () => MODELS });
    // The project's own account is the ChatGPT plan, which the engine reads the capabilities of.
    f.c.store.db
      .update(schema.accounts)
      .set({ kind: AccountKind.CodexSignin })
      .where(eq(schema.accounts.id, f.c.project.accountId))
      .run();
    const shapeId = f.c.shape.id;
    expect(f.service.create(f.c.project.id, { title: 'T', origin: ShapeOrigin.App })).toMatchObject(
      {
        title: 'T',
      },
    );
    expect(
      f.service.startFromTerminal(
        StartShapeInput.parse({ projectId: f.c.project.id, title: 'T', summary: 'S' }),
      ),
    ).toBeDefined();
    expect(f.service.chooseModel(shapeId, 'gpt-5.6-mini').model).toBe('gpt-5.6-mini');
    f.service.send(shapeId, 'Make the cards denser.');
    await f.service.settled(shapeId);
    expect(f.service.propose(shapeId)).toMatchObject({ status: 'started' });
    const { spec } = must(f.adapter.shapeSessions[0], 'a session');
    // Codex has no Agent tool: the session gets no agents, and its prompt asks for none.
    expect(spec.profile.agents).toEqual({});
    expect(spec.profile.systemPrompt).not.toContain('Agent call');
    expect(spec.profile.systemPrompt).toContain('need a Claude account');
    const conversation = f.engine.view(shapeConversation(f.c.store.db, shapeId).id);
    expect(conversation.capabilities).toMatchObject({ label: 'Codex', subagents: false });
  });
});
