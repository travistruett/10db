import { getWorkstream, insertPerson, listInbox, sendForCard, setRoutingRules } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, nameBuilder, type TestEngine } from '../../test/engine';
import { FakeSlack } from '../../test/fake-slack';
import { waitFor } from '../../test/fixtures';
import type { FakeScriptBook } from '../sessions';

let engine: TestEngine | undefined;
afterEach(async () => {
  await engine?.close();
  engine = undefined;
});

const book: FakeScriptBook = {
  Alpha: [
    [
      {
        do: 'mcp',
        tool: 'ask_human',
        args: {
          opId: 'op-wiring-ask-01',
          category: 'product',
          question: 'Charge tax?',
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '' },
          ],
        },
      },
    ],
  ],
};

/** A lane that asked a question routed to Mark, drafted and parked, with Slack faked. */
async function asked() {
  const slack = new FakeSlack();
  const live = await createTestEngine(book, {}, {}, { slack });
  engine = live;
  nameBuilder(live);
  const mark = live.store.write((ctx) =>
    insertPerson(ctx, {
      handle: 'mark',
      name: 'Mark',
      slack: { teamId: 'T1', userId: 'U1', sendMode: 'review', dailyLimit: 10 },
    }),
  ).value;
  live.store.write((ctx) =>
    setRoutingRules(ctx, live.project.id, {
      rules: [{ category: 'product', area: 'api', personId: mark.id }],
    }),
  );
  const { workstream } = live.addTask('Alpha');
  live.launch(workstream.id);
  const card = await waitFor(() => listInbox(live.store.db, { states: ['OPEN'] })[0]);
  await live.runner.idle();
  return { live, slack, card, workstream };
}

describe('a routed question, drafted and sent through the running wiring', () => {
  it('is drafted with its card, held for review, and parks the session', async () => {
    const { live, slack, card, workstream } = await asked();
    expect(sendForCard(live.store.db, card.id)).toMatchObject({
      state: 'draft',
      heldBy: 'first_send',
    });
    expect(slack.posts).toEqual([]);
    expect(getWorkstream(live.store.db, workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      currentSessionId: null,
    });
  });

  it('is sent on Send, and the builder answering it closes the send with a line in the thread', async () => {
    const { live, slack, card } = await asked();
    await live.sends.send(card.id, {});
    expect(slack.posts).toHaveLength(1);
    live.inbox.answer(card.id, { choice: 'No' });
    await waitFor(() => (slack.posts.length === 2 ? true : undefined));
    expect(slack.posts[1]?.text).toBe('Travis answered this one: B. Thanks!');
    expect(slack.posts[1]?.threadTs).toBe(slack.posts[0]?.ts);
    expect(sendForCard(live.store.db, card.id)?.state).toBe('closed');
  });

  it('closes the draft of a cancelled task, posting nothing', async () => {
    const { live, slack, card, workstream } = await asked();
    await live.runner.cancel(workstream.id);
    await waitFor(() =>
      sendForCard(live.store.db, card.id)?.state === 'closed' ? true : undefined,
    );
    expect(listInbox(live.store.db, {}).find((c) => c.id === card.id)?.state).toBe('CANCELLED');
    expect(slack.posts).toEqual([]);
  });

  it('tells the stakeholder when the task of a sent question is cancelled', async () => {
    const { live, slack, card, workstream } = await asked();
    await live.sends.send(card.id, {});
    await live.runner.cancel(workstream.id);
    await waitFor(() => (slack.posts.length === 2 ? true : undefined));
    expect(slack.posts[1]?.text).toBe('This one is no longer needed. Thanks!');
  });
});
