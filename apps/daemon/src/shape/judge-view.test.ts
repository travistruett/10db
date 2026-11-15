import { ShapeMessageKind } from '@10db/contracts';
import { listShapeMessages, shapeConversation } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createJudge } from '../judge';
import { silentLogger } from '../log';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Sessions UI §11: Plan's thread says when its session is on 10db's rules. The view carries the judge the
// session started on, not only the account's, so a gateway account with no OpenRouter key reads as the rules.

let f: ServiceFixture;
afterEach(async () => {
  await f.close();
});

describe("a Plan conversation's judge, as its view shows it", () => {
  it.each([
    ["an account 10db's judge judges, with no OpenRouter key: the rules", 'tendb', 'rules'],
    ["an account auto mode judges: auto mode's", 'native', 'native'],
  ] as const)('%s', async (_name, account, shown) => {
    f = createServiceFixture();
    f.adapter.capabilityOverrides = { judge: account };
    f.service.send(f.c.shape.id, 'Make the cards denser.');
    await f.service.settled(f.c.shape.id);
    const conversation = shapeConversation(f.c.store.db, f.c.shape.id).id;
    expect(f.engine.view(conversation).capabilities.judge).toBe(shown);
  });
});

describe("a Plan session's judge going quiet", () => {
  it("says once in Plan's thread that 10db's judge didn't answer and the rules judge", async () => {
    f = createServiceFixture({
      judge: (state) =>
        createJudge({
          state,
          clock: new ManualClock(),
          fetch: () => Promise.resolve(new Response('down', { status: 500 })),
          readKey: () => Promise.resolve('router-key-0123'),
          decisionModelIds: () => new Set(['typesafe/jev-1.13']),
          off: false,
          logger: silentLogger,
        }),
    });
    f.adapter.capabilityOverrides = { judge: 'tendb' };
    f.service.send(f.c.shape.id, 'Make the cards denser.');
    await f.service.settled(f.c.shape.id);
    const judgeCall = f.adapter.shapeSessions[0]?.spec.judgeCall;
    if (judgeCall === undefined) throw new Error('the Plan session has no session judge');
    const call = {
      toolName: 'Bash',
      input: { command: 'vercel deploy --prod' },
      cwd: '/repo',
      toolUseId: 'toolu_1',
      signal: new AbortController().signal,
      hunk: null,
    };
    await judgeCall(call);
    await judgeCall({ ...call, toolUseId: 'toolu_2' });
    const notices = listShapeMessages(f.c.store.db, f.c.shape.id).filter(
      (message) => message.kind === ShapeMessageKind.Notice,
    );
    expect(notices.map((message) => message.body)).toEqual([
      expect.stringContaining("10db's judge didn't answer"),
    ]);
  });
});
