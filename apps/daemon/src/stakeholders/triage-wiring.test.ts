import { EventType } from '@10db/contracts';
import { insertPerson, listInbox, setRoutingRules } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../test/fixtures';
import { createTestEngine, type TestEngine } from '../../test/engine';
import type { FakeScriptBook } from '../sessions';

let engine: TestEngine | undefined;
afterEach(async () => {
  await engine?.close();
  engine = undefined;
});

const SYSTEM_ONE = 'https://openrouter.ai/api/v1/systemone';

const ask = (topic?: string): FakeScriptBook => ({
  Alpha: [
    [
      {
        do: 'mcp',
        tool: 'ask_human',
        args: {
          opId: 'op-triage-ask-01',
          category: 'product',
          ...(topic === undefined ? {} : { topic }),
          question: 'Charge tax?',
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '' },
          ],
        },
      },
    ],
  ],
});

describe('a question no rule claimed, through the running wiring', () => {
  it('is routed by the judge after the lane asks, and announced as triaged', async () => {
    const asked: unknown[] = [];
    const live = await createTestEngine(
      ask(),
      {},
      {},
      {
        openRouter: {
          fetch: (url, init) => {
            expect(url).toBe(SYSTEM_ONE);
            asked.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  model: 'typesafe/jev-1.13',
                  answers: {
                    decision: {
                      type: 'choice',
                      choice: 'category:product',
                      confidence: 0.9,
                      probabilities: { 'category:product': 0.95, nobody: 0.05 },
                    },
                  },
                  usage: { cost: 0.00003 },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              ),
            );
          },
        },
      },
    );
    engine = live;
    const sarah = live.store.write((ctx) =>
      insertPerson(ctx, { handle: 'sarah', name: 'Sarah' }),
    ).value;
    live.store.write((ctx) =>
      setRoutingRules(ctx, live.project.id, {
        rules: [{ category: 'product', area: null, personId: sarah.id }],
      }),
    );
    const triaged: string[] = [];
    live.bus.subscribe((e) => {
      if (e.type === EventType.InboxTriaged) triaged.push(JSON.stringify(e.data));
    });
    const { workstream } = live.addTask('Alpha', ['api'], [], { flow: 'standard' });
    live.launch(workstream.id);

    const routed = await waitFor(() => {
      const [card] = listInbox(live.store.db, { states: ['OPEN'] });
      return card?.routedBy === 'judge' ? card : undefined;
    });
    expect(routed.assignees).toEqual(['sarah']);
    expect(asked).toHaveLength(1);
    expect(triaged).toEqual(['{"routedBy":"judge","toBuilder":false}']);
  });
});
