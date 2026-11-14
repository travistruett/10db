import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { idUuid, type ToolCallView } from '@10db/contracts';
import { getSession, updateSessionUsage } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { exploreWorld, gate, type ExploreWorld } from '../../test/explore-world';
import type { SessionEvent } from '../sessions';
import { waitFor } from '../../test/fixtures';
import { fullOutputDir } from './full-output';

// Sessions spec §6.3–§6.8: the explore engine on a real store, the fake adapter and a manual clock.

let w: ExploreWorld;
afterEach(async () => {
  await w.engine.close();
  w.close();
});

const NOW = '2026-10-13T12:00:00.000Z';
const command = (status: ToolCallView['status'], outputTail = ''): ToolCallView => ({
  kind: 'command',
  id: 'toolu_1',
  harnessTool: 'Bash',
  status,
  title: 'pnpm test',
  startedAt: NOW,
  durationMs: status === 'running' ? null : 60,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
  command: 'pnpm test',
  cwd: null,
  outputTail,
  outputBytes: outputTail.length,
  exitCode: status === 'running' ? null : 0,
});

/** Each turn waits for its gate, the next one made as each begins. */
function gatedTurns(world: ExploreWorld) {
  const gates: ReturnType<typeof gate>[] = [];
  world.adapter.shapeBehaviour = async () => {
    const g = gate();
    gates.push(g);
    await g.promise;
    return { text: 'Understood.' };
  };
  return gates;
}

describe('a turn from a queued message to a warm session', () => {
  it('starts a session for a message in idle_cold and pushes it under its row’s uuid', async () => {
    w = exploreWorld();
    const gates = gatedTurns(w);
    const message = w.send('Make the board denser.');
    expect(w.stateOf()).toBe('starting');
    await waitFor(() => gates.length === 1);
    expect(w.stateOf()).toBe('running');
    const [opened] = w.adapter.shapeSessions;
    expect(opened?.spec.promptUuid).toBe(idUuid(message.id));
    expect(opened?.spec.prompt).toBe('Make the board denser.');
    expect(getSession(w.state.db, opened?.spec.sessionId ?? never()).conversationId).toBe(
      w.conv.id,
    );
    gates[0]?.release();
    await w.engine.settled(w.conv.id);
  });

  it('stores the reply once under its live id, delivers the message and stays warm', async () => {
    w = exploreWorld();
    const message = w.send('Make the board denser.');
    await w.engine.settled(w.conv.id);
    const replies = w.items().filter((i) => i.kind === 'agent_message');
    expect(replies.map((i) => i.body)).toEqual([{ text: 'Understood.' }]);
    expect(w.engine.live(w.conv.id).items).toEqual([]);
    expect(w.frames.filter((f) => f.itemId === replies[0]?.id)).toEqual([]);
    expect(w.stateOf()).toBe('idle_warm');
    expect(w.items().find((i) => i.id === message.id)?.deliveredAt).not.toBeNull();
    expect(w.ends).toEqual([{ how: 'complete', starters: [message.id] }]);
  });

  it('pushes a second message into the warm session', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    w.send('two');
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    expect(w.adapter.shapeSessions[0]?.sent).toEqual(['two']);
    expect(w.stateOf()).toBe('idle_warm');
  });

  it('closes a session idle 10 minutes and resumes it by its agent session on the next message', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    w.clock.advance(10 * 60_000);
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_cold');
    w.send('two');
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions.map((s) => s.spec.resumeProviderSessionId)).toEqual([
      null,
      'fake-shape-1',
    ]);
  });

  it('opens no second handle when the idle close and a message land in one tick', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    const stopping = gate();
    w.adapter.shapeStopGate = stopping.promise;
    w.clock.advance(10 * 60_000);
    w.send('two');
    stopping.release();
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions).toHaveLength(2);
    expect(w.adapter.shapeSessions[1]?.spec).toMatchObject({
      resumeProviderSessionId: 'fake-shape-1',
      prompt: 'two',
    });
    expect(w.stateOf()).toBe('idle_warm');
  });

  it('runs a message queued while starting as the next turn, once the first ends', async () => {
    w = exploreWorld();
    const starting = gate();
    w.specGate = starting.promise;
    const gates = gatedTurns(w);
    w.send('one');
    const second = w.send('two');
    expect(w.stateOf()).toBe('starting');
    starting.release();
    await waitFor(() => gates.length === 1);
    expect(w.adapter.shapeSessions[0]?.spec.prompt).toBe('one');
    expect(w.adapter.shapeSessions[0]?.sent).toEqual([]);
    gates[0]?.release();
    await waitFor(() => gates.length === 2);
    expect(w.adapter.shapeSessions[0]?.sent).toEqual(['two']);
    expect(w.stateOf()).toBe('running');
    gates[1]?.release();
    await w.engine.settled(w.conv.id);
    expect(w.ends.map((e) => e.starters)).toEqual([[w.items()[0]?.id], [second.id]]);
  });

  it('switches a warm session’s model for its next turn and notes the change once', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    await w.engine.modelChanged(w.conv.id, 'claude-sonnet-5-5');
    await w.engine.modelChanged(w.conv.id, 'claude-sonnet-5-5');
    expect(w.adapter.shapeSessions[0]?.models).toEqual(['launch:claude-sonnet-5-5']);
    expect(w.stateOf()).toBe('idle_warm');
    expect(w.engine.view(w.conv.id).model).toBe('claude-sonnet-5-5');
    expect(
      w
        .items()
        .filter((i) => i.kind === 'notice')
        .map((i) => i.body),
    ).toEqual([{ kind: 'model_change', label: 'Sonnet 5.5', model: 'claude-sonnet-5-5' }]);
  });

  it.each([
    ['a metered account', 'anthropic_api_key', 0.75],
    ['a subscription', 'claude_subscription', null],
  ] as const)('answers the sessions’ summed cost on %s', async (_name, kind, cost) => {
    w = exploreWorld({ accountKind: kind });
    w.send('one');
    await w.engine.settled(w.conv.id);
    w.clock.advance(10 * 60_000);
    w.send('two');
    await w.engine.settled(w.conv.id);
    w.state.write((ctx) => {
      for (const s of w.adapter.shapeSessions)
        updateSessionUsage(ctx, s.spec.sessionId, { costUsd: 0.375 });
    });
    expect(w.engine.view(w.conv.id).costUsd).toBe(cost);
  });

  it('parks a message behind a hold, with no turn in progress, and starts it at the release', async () => {
    w = exploreWorld();
    w.engine.holdStarts(w.conv.id);
    w.send('one');
    expect(w.stateOf()).toBe('idle_cold');
    expect(w.engine.parked(w.conv.id)).toBe(true);
    expect(w.engine.busy()).toEqual([]);
    expect(w.engine.view(w.conv.id).queued).toBe(1);
    w.engine.releaseStarts(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(w.engine.parked(w.conv.id)).toBe(false);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    expect(w.stateOf()).toBe('idle_warm');
  });

  it('lets a running turn end warm under a hold taken meanwhile, and pushes the next at the release', async () => {
    w = exploreWorld();
    const gates = gatedTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);
    w.engine.holdStarts(w.conv.id);
    w.send('two');
    gates[0]?.release();
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_warm');
    expect(w.adapter.shapeSessions[0]?.sent).toEqual([]);
    w.engine.releaseStarts(w.conv.id);
    await waitFor(() => gates.length === 2);
    expect(w.adapter.shapeSessions[0]?.sent).toEqual(['two']);
    gates[1]?.release();
    await w.engine.settled(w.conv.id);
  });

  it('streams a call’s view and output as frames, then stores it with its whole output on disk', async () => {
    w = exploreWorld();
    const go = gate();
    const whole = 'x'.repeat(10_000);
    w.adapter.shapeBehaviour = async (turn) => {
      turn.emit({ type: 'tool_call', call: command('running') });
      await go.promise;
      turn.emit({ type: 'tool_call', call: command('running'), appended: 'ab' });
      await go.promise;
      const done: SessionEvent = {
        type: 'tool_call',
        call: command('done', whole.slice(-4_096)),
        full: { output: whole },
      };
      turn.emit(done);
      return {};
    };
    w.send('run the tests');
    await waitFor(() => w.frames.length === 1);
    go.release();
    await waitFor(() => w.engine.live(w.conv.id).items.length === 1);
    w.clock.advance(60);
    await w.engine.settled(w.conv.id);
    const [view, output] = w.frames;
    expect(view).toMatchObject({
      kind: 'tool_call',
      offset: 0,
      callPatch: { view: { status: 'running' } },
    });
    expect(output).toMatchObject({ offset: 0, callPatch: { output: 'ab' } });
    const calls = w.items().filter((i) => i.kind === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(view?.itemId);
    const dir = fullOutputDir(w.dataDir, w.conv.id, calls[0]?.id ?? never());
    expect(readFileSync(join(dir, 'output.txt'), 'utf8')).toBe(whole);
  });

  it('stores reasoning before the reply, complete, once the reply begins', async () => {
    w = exploreWorld();
    w.adapter.shapeBehaviour = (turn) => {
      turn.emit({ type: 'reasoning_delta', itemId: 'r1', offset: 0, text: 'Thinking it over.' });
      return Promise.resolve({ text: 'Done.' });
    };
    w.send('think');
    await w.engine.settled(w.conv.id);
    const kinds = w.items().map((i) => [i.kind, i.partial, i.body]);
    expect(kinds).toEqual([
      ['message', false, { text: 'think' }],
      ['reasoning', false, { text: 'Thinking it over.' }],
      ['agent_message', false, { text: 'Done.' }],
    ]);
  });
});

function never(): never {
  throw new Error('missing');
}

/** Turns that wait for their gate, write half a sentence first, and end at once when interrupted. */
function stoppableTurns(world: ExploreWorld, opts: { readonly lateEnd?: Promise<void> } = {}) {
  const gates: ReturnType<typeof gate>[] = [];
  world.adapter.shapeBehaviour = async (turn) => {
    const g = gate();
    gates.push(g);
    turn.emit({
      type: 'text_delta',
      itemId: `half-${String(turn.number)}`,
      offset: 0,
      text: 'Half a sen',
    });
    const aborted = new Promise<'aborted'>((resolve) => {
      turn.signal.addEventListener('abort', () => {
        resolve('aborted');
      });
    });
    if ((await Promise.race([g.promise, aborted])) === 'aborted') {
      await opts.lateEnd;
      return {};
    }
    return { text: 'Understood.' };
  };
  return gates;
}

const partials = (world: ExploreWorld) =>
  world
    .items()
    .filter((i) => i.partial)
    .map((i) => [i.kind, i.body]);

describe('Stop', () => {
  it('interrupts, keeps what streamed once, pushes again what the receipt left out, and runs the rest next', async () => {
    w = exploreWorld();
    const gates = stoppableTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);
    const lost = w.send('two');
    const kept = w.send('three');
    w.adapter.shapeInterruptReceipt = (queued) => ({ stillQueued: queued.slice(-1) });
    const stopping = w.engine.stop(w.conv.id);
    expect(w.stateOf()).toBe('stopping');
    await stopping;
    await waitFor(() => gates.length === 2 && w.ends.length === 1);
    await waitFor(() => w.adapter.shapeSessions[0]?.sent.length === 3);
    expect(w.stateOf()).toBe('running');
    expect(partials(w)).toEqual([['agent_message', { text: 'Half a sen' }]]);
    expect(w.ends.map((e) => e.how)).toEqual(['stopped']);
    expect(w.adapter.shapeSessions[0]?.sent).toEqual(['two', 'three', 'two']);
    expect(w.items().find((i) => i.id === kept.id)?.pushUuids).toHaveLength(1);
    expect(w.items().find((i) => i.id === lost.id)?.pushUuids).toHaveLength(2);
    for (const g of gates) g.release();
  });

  it('settles warm when nothing waits', async () => {
    w = exploreWorld();
    const gates = stoppableTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);
    await w.engine.stop(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_warm');
    expect(w.ends.map((e) => e.how)).toEqual(['stopped']);
    expect(partials(w)).toHaveLength(1);
  });

  it.each([
    ['the turn’s end, then the receipt', 'end-first'],
    ['the receipt, then the turn’s end', 'receipt-first'],
  ] as const)('settles a stop once when %s arrive', async (_name, order) => {
    w = exploreWorld();
    const late = gate();
    const receipt = gate();
    const gates = stoppableTurns(w, order === 'receipt-first' ? { lateEnd: late.promise } : {});
    w.adapter.shapeInterruptReceipt = async (queued) => {
      if (order === 'end-first') await receipt.promise;
      return { stillQueued: [...queued] };
    };
    w.send('one');
    await waitFor(() => gates.length === 1);
    w.send('two');
    await w.engine.stop(w.conv.id);
    await waitFor(() => w.ends.length === 1);
    // The second end of the one turn: the receipt after its end, or its own end after the receipt.
    receipt.release();
    late.release();
    await waitFor(() => gates.length === 2);
    expect(w.ends.map((e) => e.how)).toEqual(['stopped']);
    expect(partials(w)).toHaveLength(1);
    expect(w.stateOf()).toBe('running');
    gates[1]?.release();
    await w.engine.settled(w.conv.id);
    expect(w.ends.map((e) => e.how)).toEqual(['stopped', 'complete']);
    expect(w.adapter.shapeSessions[0]?.sent).toEqual(['two']);
  });

  it('stops the session when neither a receipt nor the turn’s end comes within the grace, and hands back what it held', async () => {
    w = exploreWorld();
    const gates = gatedTurns(w);
    w.adapter.shapeInterruptReceipt = () => new Promise(() => undefined);
    w.send('one');
    await waitFor(() => gates.length === 1);
    const held = w.send('two');
    await w.engine.stop(w.conv.id);
    w.clock.advance(10_000);
    await waitFor(() => w.adapter.shapeSessions.length === 2);
    expect(w.items().find((i) => i.id === held.id)?.handedBackAt).not.toBeNull();
    expect(w.ends.map((e) => e.how)).toEqual(['stopped']);
    expect(w.adapter.shapeSessions[1]?.spec).toMatchObject({
      prompt: 'two',
      resumeProviderSessionId: 'fake-shape-1',
    });
    for (const g of gates) g.release();
    await waitFor(() => gates.length === 2);
    gates[1]?.release();
    await w.engine.settled(w.conv.id);
  });

  it('cancels a start, and keeps a queued message waiting through a Stop until a new one', async () => {
    w = exploreWorld();
    const starting = gate();
    w.specGate = starting.promise;
    w.send('one');
    await w.engine.stop(w.conv.id);
    expect(w.stateOf()).toBe('idle_cold');
    starting.release();
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions).toEqual([]);
    await w.engine.stop(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions).toEqual([]);
    expect(w.engine.view(w.conv.id).queued).toBe(1);
    w.specGate = null;
    w.send('two');
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions[0]?.spec.prompt).toBe('one\n\ntwo');
  });

  it('clears a start parked behind a hold, so the release starts nothing', async () => {
    w = exploreWorld();
    w.engine.holdStarts(w.conv.id);
    w.send('one');
    await w.engine.stop(w.conv.id);
    expect(w.engine.parked(w.conv.id)).toBe(false);
    w.engine.releaseStarts(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions).toEqual([]);
    expect(w.engine.view(w.conv.id).queued).toBe(1);
  });

  it('redoes a turn with the edited message as the next one', async () => {
    w = exploreWorld();
    const gates = stoppableTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);
    const edit = await w.engine.redo(w.conv.id, () => w.keep('one, edited'));
    await waitFor(() => gates.length === 2);
    expect(w.adapter.shapeSessions[0]?.sent).toEqual(['one, edited']);
    expect(w.ends.at(0)?.how).toBe('stopped');
    gates[1]?.release();
    await w.engine.settled(w.conv.id);
    expect(w.ends.at(-1)?.starters).toEqual([edit.id]);
  });

  it('sends a resumed session the edit alone when the receipt says the message it redoes was never taken', async () => {
    w = exploreWorld();
    const gates = stoppableTurns(w);
    w.adapter.shapeInterruptReceipt = (queued) => ({ stillQueued: [...queued] });
    w.send('one');
    await waitFor(() => gates.length === 1);
    const original = w.send('two');
    await w.engine.redo(w.conv.id, () => w.keep('two, edited'));
    // The agent may begin the original before its session is stopped; later turns run straight through.
    w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Understood.' });
    for (const g of gates) g.release();
    await waitFor(() => w.adapter.shapeSessions.length === 2);
    expect(w.items().some((i) => i.id === original.id)).toBe(false);
    expect(w.adapter.shapeSessions[1]?.spec).toMatchObject({
      prompt: 'two, edited',
      resumeProviderSessionId: 'fake-shape-1',
    });
    for (const g of gates) g.release();
    await w.engine.settled(w.conv.id);
  });

  it.each([
    ['inject', ['two']],
    ['queue', []],
  ] as const)('with steer %s, a message while running goes %s', async (steer, during) => {
    w = exploreWorld();
    w.adapter.capabilityOverrides = { steer };
    const gates = gatedTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);
    w.send('two');
    // A queued message changes nothing until the turn ends; an injected one is pushed at once.
    await waitFor(() => w.adapter.shapeSessions[0]?.sent.length === during.length);
    expect(w.adapter.shapeSessions[0]?.sent).toEqual(during);
    gates[0]?.release();
    await waitFor(() => gates.length === 2);
    expect(w.adapter.shapeSessions[0]?.sent).toEqual(['two']);
    gates[1]?.release();
    await w.engine.settled(w.conv.id);
  });
});
