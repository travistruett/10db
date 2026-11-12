import { getWorkstream, insertPerson, listDecisions, listInbox, setRoutingRules } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { FakeSlack } from '../../test/fake-slack';
import { waitFor } from '../../test/fixtures';
import type { FakeScriptBook } from '../sessions';

let engine: TestEngine | undefined;
afterEach(async () => {
  await engine?.close();
  engine = undefined;
});

const ask = (opId: string, question: string) => ({
  do: 'mcp' as const,
  tool: 'ask_human',
  args: {
    opId,
    category: 'product',
    question,
    options: [
      { label: 'Give a week free', description: '' },
      { label: 'Cut access at once', description: '' },
    ],
  },
});
const book: FakeScriptBook = {
  Alpha: [[ask('op-loop-ask-0001', 'Keep access during retries?')], [{ do: 'turn_complete' }]],
  Beta: [[ask('op-loop-ask-0002', 'Another thing?')], [{ do: 'turn_complete' }]],
};

async function world() {
  const slack = new FakeSlack();
  // No OpenRouter: the judge is off, so a project route decides at insert.
  const live = await createTestEngine(book, {}, {}, { slack });
  engine = live;
  const mark = live.store.write((ctx) =>
    insertPerson(ctx, {
      handle: 'mark',
      name: 'Mark',
      slack: { teamId: 'T1', userId: 'U-mark', sendMode: 'auto', dailyLimit: null },
    }),
  ).value;
  live.store.write((ctx) =>
    setRoutingRules(ctx, live.project.id, {
      rules: [{ category: 'product', area: null, personId: mark.id }],
    }),
  );
  return { live, slack, mark };
}

/** Beta asks first and is sent to Mark by hand, so he has been sent to before and Alpha goes out by itself. */
async function seasoned(live: TestEngine) {
  const beta = live.addTask('Beta', ['ui']);
  live.launch(beta.workstream.id);
  const card = await waitFor(() => listInbox(live.store.db, { states: ['OPEN'] })[0]);
  await live.sends.send(card.id, {});
  return card;
}

describe('a stakeholder answers a lane question through the running wiring', () => {
  it('sends the question, reads his reply in the thread, answers the card as him and resumes the task quoting him', async () => {
    const { live, slack } = await world();
    const earlier = await seasoned(live);
    const alpha = live.addTask('Alpha', ['api']);
    live.launch(alpha.workstream.id);
    const card = await waitFor(() =>
      listInbox(live.store.db, { states: ['OPEN'] }).find((c) => c.id !== earlier.id),
    );
    await waitFor(() => (slack.posts.length === 2 ? true : undefined));
    const post = slack.posts[1];
    expect(post?.channel).toBe('D-U-mark');
    slack.say('D-U-mark', 'U-mark', "B, we can't give away a week of service.", post?.ts);
    await live.replyWatch.tick();
    await live.replyWatch.tick();

    expect(listInbox(live.store.db, {}).find((c) => c.id === card.id)).toMatchObject({
      state: 'RESOLVED',
      answer: { choice: 'Cut access at once', answeredBy: 'mark', via: 'slack' },
    });
    const decision = listDecisions(live.store.db, { projectId: live.project.id })[0];
    expect(decision).toMatchObject({ decidedBy: 'mark', choice: 'Cut access at once' });
    expect(getWorkstream(live.store.db, alpha.workstream.id).state).toBe('QUEUED');
    live.launch(alpha.workstream.id);
    await live.runner.idle();
    const resumed = live.adapter.prompts.at(-1)?.prompt ?? '';
    expect(resumed).toContain('Mark answered your question in Slack.');
    expect(resumed).toContain("«B, we can't give away a week of service.»");
  });

  it('parks the session at the ask, so his words reach the lane only in the quoted resume', async () => {
    const { live, slack } = await world();
    await seasoned(live);
    const alpha = live.addTask('Alpha', ['api']);
    live.launch(alpha.workstream.id);
    await waitFor(() => (slack.posts.length === 2 ? true : undefined));
    await live.runner.idle();
    // Parked at the ask, at once, long before humanWaitMinutes.
    expect(getWorkstream(live.store.db, alpha.workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      currentSessionId: null,
    });
    live.clock.advance(3 * 60_000);
    slack.say('D-U-mark', 'U-mark', 'A, give them a week.', slack.posts[1]?.ts);
    await live.replyWatch.tick();
    await live.replyWatch.tick();
    // The ask_human call never returned his words: no tool result carried them.
    expect(JSON.stringify(live.adapter.observations)).not.toContain('give them a week');
    live.launch(alpha.workstream.id);
    await live.runner.idle();
    expect(live.adapter.prompts.at(-1)?.prompt).toContain('«A, give them a week.»');
  });
});
