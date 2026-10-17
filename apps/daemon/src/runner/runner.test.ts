import {
  acquireLease,
  activeClaims,
  getTask,
  getWorkstream,
  listEventsAfter,
  listEvidence,
  listInbox,
  listSessions,
  schema,
} from '@10db/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionHandle } from '../sessions';
import { handoffArgs, waitFor } from '../../test/fixtures';
import { createTestEngine, type TestEngine } from '../../test/engine';

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

const write = (path: string, content = 'x') => ({
  do: 'tool' as const,
  toolName: 'Write',
  input: { file_path: path, content },
});
const commit = (opId: string, paths: string[]) => ({
  do: 'mcp' as const,
  tool: 'commit',
  args: { opId, paths, message: `Commit ${opId}` },
});
const turn = { do: 'turn_complete' as const };
const askShip = {
  do: 'tool' as const,
  toolName: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Ship it?',
        header: 'Ship',
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
        multiSelect: false,
      },
    ],
  },
};

const curl = {
  do: 'tool' as const,
  toolName: 'Bash',
  input: { command: 'curl -s https://example.com' },
};

let current: Parameters<typeof getWorkstream>[1];
const ws0 = () => current;
const ws = (id: Parameters<typeof getWorkstream>[1]) => getWorkstream(engine.store.db, id);
const openCard = () => listInbox(engine.store.db, { states: ['OPEN'] })[0];
const transitions = (id: Parameters<typeof getWorkstream>[1]) =>
  listEventsAfter(engine.store.db, 0, 1000)
    .filter((e) => e.type === 'workstream.changed' && e.entityId === id)
    .map((e) =>
      [e.data['from'], e.data['to']].map((s) => (typeof s === 'string' ? s : '?')).join('->'),
    );

describe('runner', () => {
  it('runs a task to DONE with gate evidence, and the guard blocks an out-of-claim write', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          write('src/ui/nope.txt'),
          write('src/api/a.txt'),
          commit('op-alpha-001', ['src/api/a.txt']),
          turn,
        ],
      ],
    });
    const { task, workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    expect(getTask(engine.store.db, task.id).status).toBe('done');
    const [gate] = listEvidence(engine.store.db, workstream.id);
    expect(gate).toMatchObject({ kind: 'gate', exitCode: 0 });
    expect(gate?.commitShas).toHaveLength(1);
    expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['review']);
    expect(
      engine.adapter.observations.find((o) => o.kind === 'denied_by_guard')?.detail['reason'],
    ).toContain('request_claim');
  });

  it('hands off at the threshold, nudges firmly near the limit, and continues in a fresh session', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          { do: 'context', percentage: 75 },
          { do: 'await_message', contains: 'write_handoff' },
          { do: 'context', percentage: 88 },
          { do: 'await_message', contains: 'almost full' },
          {
            do: 'mcp',
            tool: 'write_handoff',
            args: handoffArgs('op-handoff-1', 'Write the second file'),
          },
          turn,
        ],
        [write('src/api/b.txt'), commit('op-alpha-002', ['src/api/b.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual([
      'handoff',
      'step_done',
    ]);
    expect(engine.adapter.prompts[1]?.prompt).toContain('Next action: Write the second file');
    const states = listEventsAfter(engine.store.db, 0, 1000)
      .filter((e) => e.type === 'workstream.changed')
      .map((e) => e.data['to']);
    expect(states).toContain('HANDING_OFF');
  });

  it('sends a failed gate back as a fix with the output, then passes', async () => {
    engine = await createTestEngine(
      {
        Alpha: [
          [turn],
          [write('src/api/fixed.txt'), commit('op-fix-0001', ['src/api/fixed.txt']), turn],
        ],
      },
      { gateCommand: 'test -f src/api/fixed.txt || { echo MISSING-FIXED-FILE; exit 2; }' },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      nextAction: { kind: 'fix' },
      attempt: 1,
    });

    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]?.prompt).toContain('MISSING-FIXED-FILE');
  });

  it('parks a long wait, frees the lane, and resumes with the answer in a new session', async () => {
    engine = await createTestEngine({
      Alpha: [
        [askShip, turn],
        [write('src/api/a.txt'), commit('op-park-0001', ['src/api/a.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    expect(ws(workstream.id).state).toBe('WAITING_HUMAN');

    engine.clock.advance(10 * 60_000);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      currentSessionId: null,
      nextAction: { kind: 'answer', inboxId: card.id },
    });

    engine.inbox.answer(card.id, { choice: 'Yes' });
    expect(ws(workstream.id).state).toBe('QUEUED');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    const [first, second] = listSessions(engine.store.db, workstream.id);
    expect(engine.adapter.prompts[1]).toMatchObject({ resume: first?.providerSessionId });
    expect(engine.adapter.prompts[1]?.prompt).toContain('Answer: Yes');
    expect(second?.exitReason).toBe('step_done');
  });

  it('delivers a live answer to the same session', async () => {
    engine = await createTestEngine({
      Alpha: [[askShip, write('src/api/a.txt'), commit('op-live-0001', ['src/api/a.txt']), turn]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    engine.inbox.answer((await waitFor(openCard)).id, { choice: 'Yes' });
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    expect(engine.adapter.observations).toContainEqual(
      expect.objectContaining({
        kind: 'tool_allowed',
        detail: { toolName: 'AskUserQuestion', answers: { 'Ship it?': 'Yes' } },
      }),
    );
  });

  it('goes STARTING -> RUNNING -> WAITING_HUMAN when the first step is a question', async () => {
    engine = await createTestEngine({ Alpha: [[askShip, turn]] });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    engine.inbox.answer((await waitFor(openCard)).id, { choice: 'Yes' });
    await engine.runner.idle();
    expect(transitions(workstream.id).slice(0, 4)).toEqual([
      'QUEUED->STARTING',
      'STARTING->RUNNING',
      'RUNNING->WAITING_HUMAN',
      'WAITING_HUMAN->RUNNING',
    ]);
    expect(ws(workstream.id)).toMatchObject({ state: 'DONE', recoveryAttempts: 0 });
  });

  it('keeps an answer that arrives while the parked session is still stopping', async () => {
    engine = await createTestEngine({
      Alpha: [
        [askShip, turn],
        [write('src/api/a.txt'), commit('op-grace-0001', ['src/api/a.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    engine.clock.advance(10 * 60_000);
    engine.inbox.answer(card.id, { choice: 'Yes' });
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      recoveryAttempts: 0,
      nextAction: { kind: 'answer', inboxId: card.id },
    });

    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]?.prompt).toContain('Answer: Yes');
  });

  it.each(['allow_project', 'allow_once'])(
    'applies %s answered after parking, without asking again',
    async (choice) => {
      engine = await createTestEngine({
        Alpha: [
          [curl, turn],
          [curl, write('src/api/a.txt'), commit('op-perm-0001', ['src/api/a.txt']), turn],
        ],
      });
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      const card = await waitFor(openCard);
      engine.clock.advance(10 * 60_000);
      await engine.runner.idle();
      engine.inbox.answer(card.id, { choice });
      engine.launch(workstream.id);
      await engine.runner.idle();

      expect(ws(workstream.id).state).toBe('DONE');
      expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual([
        'review',
      ]);
      expect(
        engine.adapter.observations.filter(
          (o) => o.kind === 'tool_allowed' && o.detail['toolName'] === 'Bash',
        ),
      ).toHaveLength(1);
      expect(engine.adapter.prompts[1]?.prompt).toContain(
        'Allow Bash? curl -s https://example.com',
      );
    },
  );

  it('treats allow_project on a command with no storable rule as allow-once after parking', async () => {
    const unstorable = {
      do: 'tool' as const,
      toolName: 'Bash',
      input: { command: 'echo $(date)' },
    };
    engine = await createTestEngine({
      Alpha: [
        [unstorable, turn],
        [unstorable, write('src/api/a.txt'), commit('op-null-0001', ['src/api/a.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    engine.clock.advance(10 * 60_000);
    await engine.runner.idle();
    engine.inbox.answer(card.id, { choice: 'allow_project' });
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['review']);
    expect(
      engine.adapter.observations.filter(
        (o) => o.kind === 'tool_allowed' && o.detail['toolName'] === 'Bash',
      ),
    ).toHaveLength(1);
  });

  it('runs the gate in the session environment, never the daemon process environment', async () => {
    process.env['TENDB_PROBE'] = 'leaked';
    try {
      engine = await createTestEngine(
        { Alpha: [[write('src/api/a.txt'), commit('op-gate-env-1', ['src/api/a.txt']), turn]] },
        { gateCommand: 'test -z "$TENDB_PROBE" && test "$GATE_MARK" = yes' },
        { sessionEnv: () => ({ GATE_MARK: 'yes' }) },
      );
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id).state).toBe('DONE');
    } finally {
      delete process.env['TENDB_PROBE'];
    }
  });

  it('does not hand a continuation session off until it grows past its own starting context', async () => {
    engine = await createTestEngine(
      {
        Alpha: [
          [
            { do: 'context', percentage: 20 },
            { do: 'await_message', contains: 'write_handoff' },
            { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-base-001', 'Keep going') },
            turn,
          ],
          [
            { do: 'context', percentage: 30 },
            { do: 'context', percentage: 33 },
            { do: 'context', percentage: 36 },
            { do: 'await_message', contains: 'write_handoff' },
            {
              do: 'mcp',
              tool: 'write_handoff',
              args: handoffArgs('op-base-002', 'Write the file'),
            },
            turn,
          ],
          [write('src/api/a.txt'), commit('op-base-003', ['src/api/a.txt']), turn],
        ],
      },
      { handoffPct: 12, nudgePct: 90 },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');

    const second = listSessions(engine.store.db, workstream.id)[1];
    const events = listEventsAfter(engine.store.db, 0, 1000);
    const handoffs = events.filter(
      (e) => e.type === 'workstream.changed' && e.data['to'] === 'HANDING_OFF',
    );
    const secondHandoff = handoffs[1]?.seq ?? 0;
    const readingsBefore = events
      .filter(
        (e) => e.type === 'session.context' && e.entityId === second?.id && e.seq < secondHandoff,
      )
      .map((e) => e.data['percentage']);
    // 30% + the 5-point margin = 35%: the 30% and 33% readings must not trigger it.
    expect(readingsBefore).toEqual([30, 33, 36]);
  });

  it('treats a session environment that cannot be built as a crash, before any session row exists', async () => {
    engine = await createTestEngine(
      { Alpha: [[turn]] },
      {},
      {
        sessionEnv: () => {
          throw new Error('No Anthropic API key in the Keychain.');
        },
      },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(listSessions(engine.store.db, workstream.id)).toEqual([]);
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', recoveryAttempts: 1 });
  });

  describe('lifecycle edges', () => {
    /** Wraps every handle the fake adapter returns; the wrapper sees each call the runner makes. */
    const interceptStart = (wrap: (handle: SessionHandle) => SessionHandle) => {
      const real = engine.adapter.start.bind(engine.adapter);
      return vi.spyOn(engine.adapter, 'start').mockImplementation((spec) => wrap(real(spec)));
    };
    const doneScript = [write('src/api/a.txt'), commit('op-edge-0001', ['src/api/a.txt']), turn];

    it('stops the session process when a newer lease fences the runner off', async () => {
      engine = await createTestEngine({
        Alpha: [
          [
            { do: 'await_message', contains: 'go' },
            { do: 'activity', summary: 'later' },
            { do: 'hang' },
          ],
        ],
      });
      let inner: SessionHandle | undefined;
      let stopCalls = 0;
      interceptStart((h) => {
        inner = h;
        return {
          ...h,
          stop: () => {
            stopCalls += 1;
            return h.stop();
          },
        };
      });
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await waitFor(
        () => listSessions(engine.store.db, workstream.id)[0]?.providerSessionId ?? undefined,
      );
      engine.state.write((ctx) => {
        acquireLease(
          ctx,
          workstream.id,
          'other-daemon',
          new Date(Date.now() + 60_000).toISOString(),
        );
      });
      inner?.send('go');
      await engine.runner.idle();
      expect(stopCalls).toBeGreaterThan(0);
    });

    it('honours a cancel that arrives before the session starts', async () => {
      engine = await createTestEngine({ Alpha: [doneScript] });
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.cancel(workstream.id);
      expect(ws(workstream.id).state).toBe('CANCELLED');
      expect(engine.adapter.prompts).toEqual([]);
      expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
    });

    it.each([
      ['a cancel', 'CANCELLED', () => engine.runner.cancel(ws0())],
      [
        'a provider pause',
        'DONE',
        () => engine.runner.stopProvider(engine.project.provider, 'paused'),
      ],
    ])(
      'settles %s that lands while the finished turn is stopping',
      async (_name, expected, act) => {
        engine = await createTestEngine({ Alpha: [doneScript] });
        let first = true;
        interceptStart((h) => ({
          ...h,
          stop: () => {
            if (first) {
              first = false;
              void act();
            }
            return h.stop();
          },
        }));
        const { workstream } = engine.addTask('Alpha');
        current = workstream.id;
        engine.launch(workstream.id);
        await engine.runner.idle();
        expect(ws(workstream.id).state).toBe(expected);
        expect(
          listInbox(engine.store.db, { states: ['OPEN'] }).filter((i) => i.kind === 'flag'),
        ).toEqual([]);
      },
    );

    it.each([
      ['while the card is open', false, 'WAITING_HUMAN'],
      ['when the card was answered during the stop', true, 'QUEUED'],
    ])(
      'parks normally when the turn completes after the wait timer fired, %s',
      async (_name, answerEarly, expected) => {
        engine = await createTestEngine({ Alpha: [[askShip, turn]] });
        let first = true;
        // The timer's stop is swallowed so the script runs on to turn_complete and a normal end, as a real adapter can.
        interceptStart((h) => ({
          ...h,
          stop: () => {
            if (!first) return h.stop();
            first = false;
            const card = openCard();
            if (answerEarly && card) engine.inbox.answer(card.id, { choice: 'Yes' });
            return Promise.resolve();
          },
        }));
        const { workstream } = engine.addTask('Alpha');
        engine.launch(workstream.id);
        const card = await waitFor(openCard);
        engine.clock.advance(10 * 60_000);
        await engine.runner.idle();

        expect(ws(workstream.id)).toMatchObject({
          state: expected,
          currentSessionId: null,
          recoveryAttempts: 0,
          nextAction: { kind: 'answer', inboxId: card.id },
        });
        expect(listSessions(engine.store.db, workstream.id)[0]?.exitReason).toBe('parked');
        if (!answerEarly) {
          engine.inbox.answer(card.id, { choice: 'Yes' });
          expect(ws(workstream.id).state).toBe('QUEUED');
        }
      },
    );

    it.each([
      ['a provider pause', () => engine.runner.stopProvider(engine.project.provider, 'paused')],
      ['a shutdown', () => engine.runner.stopAll('shutdown')],
    ])(
      'keeps an answer that lands while %s is still stopping a waiting session',
      async (_name, act) => {
        engine = await createTestEngine({
          Alpha: [
            [askShip, { do: 'hang' }],
            [write('src/api/a.txt'), commit('op-slow-0001', ['src/api/a.txt']), turn],
          ],
        });
        let release: () => void = () => undefined;
        const released = new Promise<void>((r) => {
          release = r;
        });
        // A real session can take a while to exit; this one exits only when the test says so.
        interceptStart((h) => ({
          ...h,
          stop: async () => {
            await released;
            await h.stop();
          },
        }));
        const { workstream } = engine.addTask('Alpha');
        engine.launch(workstream.id);
        const card = await waitFor(openCard);
        expect(ws(workstream.id).state).toBe('WAITING_HUMAN');

        const stopping = act();
        engine.inbox.answer(card.id, { choice: 'Yes' });
        release();
        await stopping;
        await engine.runner.idle();
        expect(ws(workstream.id)).toMatchObject({
          state: 'QUEUED',
          currentSessionId: null,
          nextAction: { kind: 'answer', inboxId: card.id },
        });

        engine.launch(workstream.id);
        await engine.runner.idle();
        expect(ws(workstream.id).state).toBe('DONE');
        expect(engine.adapter.prompts[1]?.prompt).toContain('Answer: Yes');
      },
    );

    it('ends the session and frees it for a parked answer when the loop fails while waiting', async () => {
      engine = await createTestEngine({ Alpha: [[askShip, { do: 'hang' }]] });
      let fail: (error: Error) => void = () => undefined;
      const failed = new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
      failed.catch(() => undefined);
      // Stands in for a database or IO error thrown inside the event loop.
      interceptStart((h) => ({
        ...h,
        events: (async function* () {
          const inner = h.events[Symbol.asyncIterator]();
          for (;;) {
            const next = await Promise.race([inner.next(), failed]);
            if (next.done) return;
            yield next.value;
          }
        })(),
      }));
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      const card = await waitFor(openCard);
      fail(new Error('disk I/O error'));
      await engine.runner.idle();

      expect(ws(workstream.id)).toMatchObject({
        state: 'WAITING_HUMAN',
        currentSessionId: null,
        nextAction: { kind: 'answer', inboxId: card.id },
      });
      expect(listSessions(engine.store.db, workstream.id)[0]?.endedAt).not.toBeNull();
      engine.inbox.answer(card.id, { choice: 'Yes' });
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        nextAction: { kind: 'answer', inboxId: card.id },
      });
    });

    /** Makes the second session the adapter starts end without ever reporting `started`. */
    const secondSessionNeverStarts = () => {
      let calls = 0;
      interceptStart((h) => {
        calls += 1;
        if (calls !== 2) return h;
        return {
          ...h,
          events: (async function* () {
            for await (const event of h.events) if (event.type !== 'started') yield event;
          })(),
        };
      });
    };
    const crash = { do: 'crash' as const, message: 'boom before started' };

    it.each([
      ['a question answer', askShip, 'Yes', [...doneScript], 'Answer: Yes'],
      [
        'an allow_once permission',
        curl,
        'allow_once',
        [curl, ...doneScript],
        'Allow Bash? curl -s https://example.com',
      ],
    ])(
      'carries %s into the next session when the answered session crashes before it starts',
      async (_name, ask, choice, finalScript, promptText) => {
        engine = await createTestEngine({ Alpha: [[ask, turn], [crash], finalScript] });
        secondSessionNeverStarts();
        const { workstream } = engine.addTask('Alpha');
        engine.launch(workstream.id);
        const card = await waitFor(openCard);
        engine.clock.advance(10 * 60_000);
        await engine.runner.idle();
        engine.inbox.answer(card.id, { choice });
        engine.launch(workstream.id);
        await engine.runner.idle();
        expect(ws(workstream.id)).toMatchObject({
          state: 'QUEUED',
          recoveryAttempts: 1,
          nextAction: { kind: 'answer', inboxId: card.id },
        });

        engine.launch(workstream.id);
        await engine.runner.idle();
        expect(ws(workstream.id).state).toBe('DONE');
        expect(engine.adapter.prompts[2]?.prompt).toContain(promptText);
        expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual([
          'review',
        ]);
        expect(
          engine.adapter.observations.filter(
            (o) => o.kind === 'tool_allowed' && o.detail['toolName'] === 'Bash',
          ),
        ).toHaveLength(choice === 'allow_once' ? 1 : 0);
      },
    );

    it('carries the gate failure into the next session when the fix session crashes before it starts', async () => {
      engine = await createTestEngine(
        {
          Alpha: [
            [turn],
            [crash],
            [write('src/api/fixed.txt'), commit('op-fixc-0001', ['src/api/fixed.txt']), turn],
          ],
        },
        { gateCommand: 'test -f src/api/fixed.txt || { echo MISSING-FIXED-FILE; exit 2; }' },
      );
      secondSessionNeverStarts();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        recoveryAttempts: 1,
        nextAction: { kind: 'fix' },
      });

      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id).state).toBe('DONE');
      expect(engine.adapter.prompts[2]?.prompt).toContain('MISSING-FIXED-FILE');
    });

    it('keeps a rejected usage limit when the turn completes afterwards', async () => {
      engine = await createTestEngine({
        Alpha: [[{ do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 }]],
      });
      interceptStart((h) => ({
        ...h,
        events: (async function* () {
          for await (const event of h.events) {
            yield event;
            if (event.type === 'rate_limit')
              yield { type: 'turn_complete' as const, inputTokens: 1, outputTokens: 1, costUsd: 0 };
          }
        })(),
      }));
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id).state).toBe('PAUSED_LIMIT');
      expect(engine.rateLimited).toHaveLength(1);
    });
  });

  it('resets the crash count once a session makes progress', async () => {
    engine = await createTestEngine({
      Alpha: [
        [{ do: 'crash', message: 'boom' }],
        [write('src/api/a.txt'), commit('op-reset-0001', ['src/api/a.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).recoveryAttempts).toBe(1);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'DONE', recoveryAttempts: 0 });
  });

  it('cancels during verification by killing the gate', async () => {
    engine = await createTestEngine({ Alpha: [[turn]] }, { gateCommand: 'sleep 30' });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => ws(workstream.id).state === 'VERIFYING');
    const started = Date.now();
    await engine.runner.cancel(workstream.id);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ws(workstream.id).state).toBe('CANCELLED');
    expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
  });

  it('retries crashes as resume, then fresh, and fails after the limit with a flag', async () => {
    const crash = { do: 'crash' as const, message: 'boom' };
    engine = await createTestEngine({ Alpha: [[crash], [crash], [crash], [crash]] });
    const { workstream } = engine.addTask('Alpha');
    const kinds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      engine.launch(workstream.id);
      await engine.runner.idle();
      kinds.push(
        ws(workstream.id).state === 'QUEUED'
          ? ws(workstream.id).nextAction.kind
          : ws(workstream.id).state,
      );
    }
    expect(kinds).toEqual(['resume', 'start', 'resume', 'FAILED']);
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['flag']);
  });

  it('cancels a running workstream, releasing claims', async () => {
    engine = await createTestEngine({
      Alpha: [[{ do: 'activity', summary: 'working' }, { do: 'hang' }]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(
      () => listSessions(engine.store.db, workstream.id)[0]?.providerSessionId ?? undefined,
    );
    await engine.runner.cancel(workstream.id);
    expect(ws(workstream.id).state).toBe('CANCELLED');
    expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
  });

  it('pauses on a usage limit until the reported reset', async () => {
    engine = await createTestEngine({
      Alpha: [[{ do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 }]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('PAUSED_LIMIT');
    expect(ws(workstream.id).pausedUntil).not.toBeNull();
    expect(engine.rateLimited).toHaveLength(1);
  });

  it('logs emergency compaction as a deviation and re-sends the context pack', async () => {
    engine = await createTestEngine({
      Alpha: [[{ do: 'compact' }, { do: 'await_message', contains: 'context pack' }, turn]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.store.db.select().from(schema.deviations).all()).toHaveLength(1);
  });

  it('runs the after-session check once per session, and survives it throwing', async () => {
    const seen: string[] = [];
    engine = await createTestEngine(
      { Alpha: [[write('src/api/a.txt'), commit('op-after-001', ['src/api/a.txt']), turn]] },
      {},
      {
        afterSession: (id) => {
          seen.push(id);
          return Promise.reject(new Error('watcher broke'));
        },
      },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(seen).toEqual([workstream.id]);
    expect(ws(workstream.id).state).toBe('DONE');
  });
});
