import { shapeConversation } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
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
