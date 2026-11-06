import {
  AccountKind,
  BRAINSTORM_REFUSED_ON_CHATGPT,
  InvalidError,
  ShapeOrigin,
  StartShapeInput,
  type SupportedAccountKind,
} from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// A project on a ChatGPT account can't run a conversation. Each request that would start or advance one is
// refused when it is made, before it writes anything.

let f: ServiceFixture;
afterEach(async () => {
  await f.close();
});

const requests: [string, () => unknown][] = [
  ['create', () => f.service.create(f.c.project.id, { title: 'T', origin: ShapeOrigin.App })],
  ['send', () => f.service.send(f.c.shape.id, 'Make the cards denser.')],
  ['propose', () => f.service.propose(f.c.shape.id)],
  ['rehearse', () => f.service.rehearse(f.c.shape.id)],
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
    f = createServiceFixture({ accountKind: AccountKind.CodexSignin });
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
    expect(f.service.list(f.c.project.id)).toHaveLength(listed);
    expect(f.adapter.shapeSessions).toHaveLength(0);
  });

  it.each<SupportedAccountKind>([AccountKind.ClaudeSubscription, AccountKind.Bedrock])(
    'is not refused on a %s account',
    (accountKind) => {
      f = createServiceFixture({ accountKind });
      expect(() => f.service.send(f.c.shape.id, 'Make the cards denser.')).not.toThrow();
      expect(f.service.propose(f.c.shape.id)).toMatchObject({ status: 'started' });
    },
  );
});
