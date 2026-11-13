import {
  AccountKind,
  BRAINSTORM_REFUSED_ON_CHATGPT,
  InvalidError,
  ShapeOrigin,
  StartShapeInput,
  type AgentAccountKind,
} from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// A project on a ChatGPT account can't run a conversation. Each request that would start or advance one,
// or choose the model it runs on, is refused when it is made, before it writes anything.

/** The models a Claude account offers, so a model choice is refused for the account, not the model. */
const MODELS = {
  default: 'claude-opus-5-5',
  offered: [
    { model: 'claude-opus-5-5', tier: 'strongest' as const },
    { model: 'claude-sonnet-5-5', tier: 'balanced' as const },
  ],
};

let f: ServiceFixture;
afterEach(async () => {
  await f.close();
});

const requests: [string, () => unknown][] = [
  ['create', () => f.service.create(f.c.project.id, { title: 'T', origin: ShapeOrigin.App })],
  ['send', () => f.service.send(f.c.shape.id, 'Make the cards denser.')],
  ['propose', () => f.service.propose(f.c.shape.id)],
  ['rehearse', () => f.service.rehearse(f.c.shape.id)],
  ['a model choice', () => f.service.chooseModel(f.c.shape.id, 'claude-sonnet-5-5')],
  [
    'start_shape',
    () =>
      f.service.startFromTerminal(
        StartShapeInput.parse({ projectId: f.c.project.id, title: 'T', summary: 'S' }),
      ),
  ],
];

describe('a conversation on a ChatGPT account', () => {
  it.each(requests)('refuses %s and writes nothing', (_name, request) => {
    f = createServiceFixture({ accountKind: AccountKind.CodexSignin, models: () => MODELS });
    const before = f.service.view(f.c.shape.id);
    const listed = f.service.list(f.c.project.id).length;
    let thrown: unknown;
    try {
      request();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidError);
    expect(thrown).toMatchObject({ message: BRAINSTORM_REFUSED_ON_CHATGPT });
    const after = f.service.view(f.c.shape.id);
    expect(after.messages).toEqual(before.messages);
    expect(after.shape.proposeUnlocked).toBe(before.shape.proposeUnlocked);
    expect(after.shape.model).toBe(before.shape.model);
    expect(f.service.list(f.c.project.id)).toHaveLength(listed);
    expect(f.adapter.shapeSessions).toHaveLength(0);
  });

  it.each<AgentAccountKind>([AccountKind.ClaudeSubscription, AccountKind.Bedrock])(
    'is not refused on a %s account',
    (accountKind) => {
      f = createServiceFixture({ accountKind, models: () => MODELS });
      expect(f.service.chooseModel(f.c.shape.id, 'claude-sonnet-5-5').model).toBe(
        'claude-sonnet-5-5',
      );
      expect(() => f.service.send(f.c.shape.id, 'Make the cards denser.')).not.toThrow();
      expect(f.service.propose(f.c.shape.id)).toMatchObject({ status: 'started' });
    },
  );
});
