import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationState, idUuid, type ToolCallView } from '@10db/contracts';
import {
  getConversation,
  getSession,
  insertInboxItem,
  listAccountModels,
  patchConversation,
  replaceAccountModels,
  updateSessionUsage,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { exploreWorld, gate, type ExploreWorld } from '../../test/explore-world';
import type { SessionEvent } from '../sessions';
import { waitFor } from '../../test/fixtures';
import { FRESH_SESSION_NOTICE } from './explore-engine';
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
    expect(w.engine.releaseStarts(w.conv.id)).toBe(true);
    await w.engine.settled(w.conv.id);
    expect(w.engine.parked(w.conv.id)).toBe(false);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    expect(w.stateOf()).toBe('idle_warm');
  });

  it('says no turn began when a release finds nothing parked', () => {
    w = exploreWorld();
    w.engine.holdStarts(w.conv.id);
    expect(w.engine.releaseStarts(w.conv.id)).toBe(false);
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

  it('lists a background report that arrives after a Stop settled and before the turn’s own end', async () => {
    w = exploreWorld();
    const late = gate();
    const began = gate();
    w.adapter.shapeBehaviour = async (turn) => {
      if (turn.number > 1) return { text: 'Understood.' };
      began.release();
      await new Promise<void>((resolve) => {
        turn.signal.addEventListener('abort', () => {
          resolve();
        });
      });
      await late.promise;
      turn.emit({
        type: 'background_tasks',
        tasks: [{ id: 't1', description: 'npm run build', kind: 'local_bash' }],
      });
      return {};
    };
    w.adapter.shapeInterruptReceipt = (queued) => Promise.resolve({ stillQueued: [...queued] });
    w.send('one');
    await began.promise;
    await waitFor(() => w.stateOf() === 'running');
    // A second message keeps the session open through the Stop, as it does in the real engine.
    w.send('two');
    await w.engine.stop(w.conv.id);
    expect(w.engine.view(w.conv.id).backgroundTasks).toEqual([]);
    late.release();
    await waitFor(() => w.engine.view(w.conv.id).backgroundTasks.length === 1);
    expect(w.engine.view(w.conv.id).backgroundTasks[0]).toMatchObject({
      description: 'npm run build',
      kind: 'shell',
    });
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

const NO_RESUME = { reason: 'error', message: 'No conversation found to resume.' } as const;

describe('fresh sessions', () => {
  it('closes a session that ends a turn past 70% and starts the next fresh from a stored digest', async () => {
    w = exploreWorld();
    w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Understood.', contextPercent: 71 });
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_cold');
    expect(w.items().at(-1)?.body).toEqual({
      text: 'Continued in a fresh session. Nothing is lost.',
    });
    w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Again.' });
    w.send('two');
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions[1]?.spec.resumeProviderSessionId).toBeNull();
    const kinds = w.items().map((i) => i.kind);
    expect(kinds.indexOf('digest')).toBeGreaterThan(kinds.lastIndexOf('notice'));
    expect(w.starts.at(-1)?.digest).toContain('Understood.');
  });

  it('keeps a session warm at exactly 70%', async () => {
    w = exploreWorld();
    w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Understood.', contextPercent: 70 });
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_warm');
  });

  it('starts fresh from the digest once when a resume fails, and ends in error when that fails too', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    w.clock.advance(10 * 60_000);
    await w.engine.settled(w.conv.id);
    w.adapter.shapeStartFailure = (spec) =>
      spec.resumeProviderSessionId === null ? null : NO_RESUME;
    w.send('two');
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions.map((s) => s.spec.resumeProviderSessionId)).toEqual([
      null,
      'fake-shape-1',
      null,
    ]);
    expect(w.adapter.shapeSessions[2]?.spec.prompt).toBe('two');
    expect(w.items().filter((i) => i.kind === 'digest')).toHaveLength(1);
    expect(w.stateOf()).toBe('idle_warm');

    w.clock.advance(10 * 60_000);
    await w.engine.settled(w.conv.id);
    w.adapter.shapeStartFailure = () => NO_RESUME;
    w.send('three');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('ended_error');
  });
});

const RESET_MS = 20 * 60_000;
const sendNowLines = (world: ExploreWorld) => world.items().filter((i) => i.kind === 'turn_marker');
const notices = (world: ExploreWorld) =>
  world
    .items()
    .filter((i) => i.kind === 'notice')
    .map((i) => i.body);

/** A turn that streams half a sentence, then ends its session as `reason`, after `before` if given. */
function endingTurn(
  world: ExploreWorld,
  reason: 'rate_limited' | 'error' | 'completed' | 'model_refused',
  opts: { readonly resetsAt?: Date | null; readonly before?: Promise<void> } = {},
) {
  world.adapter.shapeBehaviour = async (turn) => {
    turn.emit({ type: 'text_delta', itemId: 'half', offset: 0, text: 'Half a sen' });
    if (opts.resetsAt !== undefined)
      turn.emit({
        type: 'rate_limit',
        status: 'rejected',
        resetsAt: opts.resetsAt,
        utilization: 1,
        limitType: 'five_hour',
      });
    await opts.before;
    world.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Back.' });
    return { end: { reason, message: `ended: ${reason}` } };
  };
}

describe('ends', () => {
  it.each([
    ['at the reported reset', RESET_MS, RESET_MS],
    ['after the default pause when no reset is reported', null, 30 * 60_000],
  ] as const)('pauses on a rate limit and runs the queue %s', async (_name, resetIn, wait) => {
    w = exploreWorld();
    const resetsAt = resetIn === null ? null : new Date(w.clock.now().getTime() + resetIn);
    const held = gate();
    endingTurn(w, 'rate_limited', { resetsAt, before: held.promise });
    w.send('one');
    await waitFor(() => w.engine.live(w.conv.id).items.length === 1);
    held.release();
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('paused_account');
    expect(partials(w)).toEqual([['agent_message', { text: 'Half a sen' }]]);
    expect(w.engine.view(w.conv.id).pausedUntil).toBe(
      new Date(w.clock.now().getTime() + wait).toISOString(),
    );
    expect(notices(w)).toHaveLength(1);
    w.send('two');
    expect(w.engine.view(w.conv.id).queued).toBe(1);
    w.clock.advance(wait - 1);
    expect(w.stateOf()).toBe('paused_account');
    w.clock.advance(1);
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions[1]?.spec.prompt).toContain('two');
    expect(w.stateOf()).toBe('idle_warm');
  });

  it('pauses a start the account runtime holds, until the hold’s end', async () => {
    let blocked: { until: Date | null } | null = null;
    w = exploreWorld({ deps: { accountBlocked: () => blocked } });
    blocked = { until: new Date(w.clock.now().getTime() + RESET_MS) };
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('paused_account');
    expect(w.adapter.shapeSessions).toEqual([]);
    blocked = null;
    w.clock.advance(RESET_MS);
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    expect(w.stateOf()).toBe('idle_warm');
  });

  it('waits out a metered account at its cap with one notice and no loop, until the account can run', async () => {
    let blocked: { until: Date | null } | null = { until: null };
    w = exploreWorld({ accountKind: 'anthropic_api_key', deps: { accountBlocked: () => blocked } });
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('paused_account');
    expect(w.engine.view(w.conv.id).pausedUntil).toBeNull();
    expect(w.clock.pendingTimers()).toBe(1);
    for (const text of ['two', 'three', 'four']) w.send(text);
    const changed = (): void => {
      w.state.write((ctx) => {
        ctx.emit({
          type: 'account.saved',
          entityType: 'account',
          entityId: w.project.accountId,
          data: {},
        });
      });
    };
    changed();
    await w.engine.settled(w.conv.id);
    expect(notices(w)).toHaveLength(1);
    expect(w.stateOf()).toBe('paused_account');
    expect(w.adapter.shapeSessions).toEqual([]);
    blocked = null;
    changed();
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions[0]?.spec.prompt).toBe('one\n\ntwo\n\nthree\n\nfour');
    expect(notices(w)).toHaveLength(1);
  });

  it('hands back what an errored session held, and waits under one Send now line for the next message', async () => {
    w = exploreWorld();
    const held = gate();
    endingTurn(w, 'error', { before: held.promise });
    w.send('one');
    await waitFor(() => w.engine.live(w.conv.id).items.length === 1);
    const injected = w.send('two');
    await waitFor(() => w.adapter.shapeSessions[0]?.sent.length === 1);
    held.release();
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('ended_error');
    expect(partials(w)).toHaveLength(1);
    expect(w.items().find((i) => i.id === injected.id)?.handedBackAt).not.toBeNull();
    expect(sendNowLines(w)).toHaveLength(1);
    w.send('three');
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions[1]?.spec.prompt).toBe('two\n\nthree');
  });

  it.each([
    ['running', 'idle_cold'],
    ['starting', 'ended_error'],
  ] as const)('reads an end it did not ask for while %s as %s', async (from, to) => {
    w = exploreWorld();
    if (from === 'running') endingTurn(w, 'completed');
    else w.adapter.shapeStartFailure = () => ({ reason: 'completed', message: 'exited' });
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe(to);
  });

  it('hands back what a session that exited by itself held, under Send now, and runs nothing', async () => {
    w = exploreWorld();
    const held = gate();
    endingTurn(w, 'completed', { before: held.promise });
    w.send('one');
    await waitFor(() => w.engine.live(w.conv.id).items.length === 1);
    const injected = w.send('two');
    await waitFor(() => w.adapter.shapeSessions[0]?.sent.length === 1);
    held.release();
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_cold');
    expect(w.items().find((i) => i.id === injected.id)?.handedBackAt).not.toBeNull();
    expect(sendNowLines(w)).toHaveLength(1);
    expect(w.adapter.shapeSessions).toHaveLength(1);
  });

  it('marks the model unusable when the account refuses it', async () => {
    w = exploreWorld();
    w.state.write((ctx) =>
      replaceAccountModels(ctx, w.project.accountId, [
        {
          model: 'claude-opus-5-5',
          family: null,
          launchId: 'claude-opus-5-5',
          efforts: [],
          inputPrice: null,
          outputPrice: null,
        },
      ]),
    );
    w.adapter.shapeBehaviour = () => Promise.resolve({ refusedModel: true });
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(listAccountModels(w.state.db, w.project.accountId)).toMatchObject([
      { model: 'claude-opus-5-5', unusable: true },
    ]);
    expect(w.stateOf()).toBe('ended_error');
  });
});

describe('cards', () => {
  /** A card the session waits on, as the broker raises it: a real Inbox item. */
  function raiseCard(world: ExploreWorld) {
    const item = world.state.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: world.project.id,
        kind: 'permission',
        title: 'Allow Bash?',
        body: 'pnpm test',
        options: [],
        recommendation: null,
        category: 'access',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [],
      }),
    );
    const start = world.starts[0];
    if (start === undefined) throw new Error('no start');
    start.observer.onWaitStart(item);
    return {
      item,
      settle: () => {
        start.observer.onWaitEnd(item);
      },
    };
  }

  it('holds the state on a card, shows it as an item, and goes on when it is answered', async () => {
    w = exploreWorld();
    const gates = gatedTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);
    const card = raiseCard(w);
    expect(w.stateOf()).toBe('waiting_card');
    expect(
      w
        .items()
        .filter((i) => i.kind === 'card')
        .map((i) => i.body),
    ).toEqual([{ inboxItemId: card.item.id }]);
    card.settle();
    expect(w.stateOf()).toBe('running');
    gates[0]?.release();
    await w.engine.settled(w.conv.id);
  });

  it('waits while any of two cards is open, and withdraws both on Stop', async () => {
    const withdrawn: string[] = [];
    w = exploreWorld({ deps: { withdrawCard: (id) => withdrawn.push(id) } });
    const gates = stoppableTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);
    const first = raiseCard(w);
    const second = raiseCard(w);
    first.settle();
    expect(w.stateOf()).toBe('waiting_card');
    second.settle();
    expect(w.stateOf()).toBe('running');
    const third = raiseCard(w);
    const fourth = raiseCard(w);
    await w.engine.stop(w.conv.id);
    expect(withdrawn).toEqual([third.item.id, fourth.item.id]);
    await w.engine.settled(w.conv.id);
  });

  it('withdraws a waiting card when Do It seals the conversation', async () => {
    const withdrawn: string[] = [];
    w = exploreWorld({ deps: { withdrawCard: (id) => withdrawn.push(id) } });
    const gates = stoppableTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);
    const card = raiseCard(w);

    await w.engine.seal(w.conv.id);

    expect(withdrawn).toEqual([card.item.id]);
    expect(w.stateOf()).toBe('sealed');
  });

  it('withdraws a card on Stop, and on an end', async () => {
    const withdrawn: string[] = [];
    w = exploreWorld({ deps: { withdrawCard: (id) => withdrawn.push(id) } });
    const gates = stoppableTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);
    const first = raiseCard(w);
    await w.engine.stop(w.conv.id);
    expect(withdrawn).toEqual([first.item.id]);
    await w.engine.settled(w.conv.id);

    const held = gate();
    endingTurn(w, 'error', { before: held.promise });
    w.send('two');
    await waitFor(() => w.engine.live(w.conv.id).items.length === 1);
    const second = raiseCard(w);
    held.release();
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('ended_error');
    expect(withdrawn).toEqual([first.item.id, second.item.id]);
  });
});

describe('the warm cap', () => {
  it('closes the longest idle session when a fifth goes idle, with no notice', async () => {
    w = exploreWorld();
    const convs = [
      { conv: w.conv, send: (t: string) => w.send(t) },
      ...[1, 2, 3, 4].map(() => w.another()),
    ];
    for (const c of convs) {
      c.send('hello');
      await w.engine.settled(c.conv.id);
      w.clock.advance(60_000);
    }
    expect(convs.map((c) => w.engine.view(c.conv.id).state)).toEqual([
      'idle_cold',
      'idle_warm',
      'idle_warm',
      'idle_warm',
      'idle_warm',
    ]);
    expect(w.items().filter((i) => i.kind === 'notice')).toEqual([]);
    w.send('again');
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions.at(-1)?.spec.resumeProviderSessionId).toBe('fake-shape-1');
  });

  it('starts fresh next when the cap closes a session past the context limit', async () => {
    w = exploreWorld({ deps: { warmCap: 0 } });
    w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Understood.', contextPercent: 80 });
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_cold');
    expect(notices(w)).toEqual([{ text: FRESH_SESSION_NOTICE }]);
    w.send('two');
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions.at(-1)?.spec.resumeProviderSessionId).toBeNull();
  });

  it('never closes a running session for the cap, only an idle one', async () => {
    w = exploreWorld();
    const idle = w.another();
    idle.send('hello');
    await w.engine.settled(idle.conv.id);
    const gates = gatedTurns(w);
    const running = [1, 2, 3, 4].map(() => w.another());
    for (const c of running) c.send('work');
    await waitFor(() => gates.length === 4);
    w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Understood.' });
    w.clock.advance(60_000);
    w.send('hello');
    await w.engine.settled(w.conv.id);
    expect(w.engine.view(idle.conv.id).state).toBe('idle_cold');
    expect(w.stateOf()).toBe('idle_warm');
    expect(running.map((c) => w.engine.view(c.conv.id).state)).toEqual([
      'running',
      'running',
      'running',
      'running',
    ]);
    for (const g of gates) g.release();
    for (const c of running) await w.engine.settled(c.conv.id);
  });

  it('opens no second handle when a cap close and a message to it land in one tick', async () => {
    w = exploreWorld();
    const convs = [
      { conv: w.conv, send: (t: string) => w.send(t) },
      ...[1, 2, 3].map(() => w.another()),
    ];
    for (const c of convs) {
      c.send('hello');
      await w.engine.settled(c.conv.id);
      w.clock.advance(60_000);
    }
    const stopping = gate();
    w.adapter.shapeStopGate = stopping.promise;
    const fifth = w.another();
    fifth.send('hello');
    await waitFor(() => w.adapter.shapeSessions.length === 5);
    await waitFor(() => w.engine.view(fifth.conv.id).state === 'idle_warm');
    w.send('again');
    stopping.release();
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions.at(-1)?.spec).toMatchObject({
      resumeProviderSessionId: 'fake-shape-1',
      prompt: 'again',
    });
  });
});

describe('review round 1', () => {
  it('drops a stopped turn’s late events in its own session only, so the next session’s turn ends', async () => {
    w = exploreWorld();
    const never = new Promise<void>(() => undefined);
    const gates = stoppableTurns(w, { lateEnd: never });
    w.adapter.shapeInterruptReceipt = () => ({ stillQueued: [] });
    w.send('one');
    await waitFor(() => gates.length === 1);
    await w.engine.stop(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_warm');
    // The session dies before the stopped turn's own end arrives.
    await w.adapter.shapeSessions[0]?.handle.stop();
    await w.engine.settled(w.conv.id);
    w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Again.' });
    w.send('two');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_warm');
    expect(w.ends.map((e) => e.how)).toEqual(['stopped', 'complete']);
  });

  it.each([
    ['taken', false],
    ['never taken', true],
  ] as const)(
    'keeps the original and settles the stop when a Redo of a %s message cannot store its edit',
    async (_name, untaken) => {
      w = exploreWorld();
      const gates = stoppableTurns(w);
      w.adapter.shapeInterruptReceipt = (queued) => ({ stillQueued: untaken ? [...queued] : [] });
      w.send('one');
      await waitFor(() => gates.length === 1);
      const original = untaken ? w.send('two') : w.items()[0];
      await expect(
        w.engine.redo(w.conv.id, () => {
          throw new Error('the edit could not be stored');
        }),
      ).rejects.toThrow('the edit could not be stored');
      w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Understood.' });
      for (const g of gates) g.release();
      await w.engine.settled(w.conv.id);
      expect(w.items().some((i) => i.id === original?.id)).toBe(true);
      expect(w.stateOf()).not.toBe('stopping');
    },
  );

  it('hands back what a turn dropped, and pushes it again as the next turn', async () => {
    w = exploreWorld();
    const first = gate();
    w.adapter.shapeBehaviour = async (turn) => {
      if (turn.number > 1) return { text: 'Again.' };
      await first.promise;
      return { text: 'Understood.', dropQueued: true };
    };
    w.send('one');
    await waitFor(() => w.stateOf() === 'running');
    const dropped = w.send('two');
    await waitFor(() => w.adapter.shapeSessions[0]?.sent.length === 1);
    first.release();
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_warm');
    expect(w.adapter.shapeSessions[0]?.sent).toEqual(['two', 'two']);
    expect(w.items().find((i) => i.id === dropped.id)?.deliveredAt).not.toBeNull();
  });

  it('leaves a starter the receipt says is still queued untaken, and runs it as the next turn', async () => {
    w = exploreWorld();
    const gates = stoppableTurns(w);
    const message = w.send('one');
    await waitFor(() => gates.length === 1);
    const uuid = w.adapter.shapeSessions[0]?.spec.promptUuid ?? '';
    w.adapter.shapeInterruptReceipt = () => ({ stillQueued: [uuid] });
    await w.engine.stop(w.conv.id);
    expect(w.items().find((i) => i.id === message.id)?.deliveredAt).toBeNull();
    expect(w.stateOf()).toBe('running');
  });

  it('bounds the wait for a session that will not stop, so the next start goes on', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    w.adapter.shapeStopGate = new Promise(() => undefined);
    w.clock.advance(10 * 60_000);
    w.send('two');
    await waitFor(() => w.clock.pendingTimers() > 0 && w.stateOf() === 'starting');
    w.clock.advance(10_000);
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).not.toBe('starting');
  });

  it('ends a start whose message could not be built in error, and releases its launch', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    w.clock.advance(10 * 60_000);
    w.overrides = {
      outgoing: () => {
        throw new Error('the picture could not be read');
      },
    };
    w.send('two');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('ended_error');
    expect(notices(w).at(-1)).toEqual({ text: 'the picture could not be read' });
  });

  it('reads a cancelled resume, then a failed start, as no failed resume, and keeps one digest', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    w.clock.advance(10 * 60_000);
    await w.engine.settled(w.conv.id);
    const starting = gate();
    w.adapter.shapeStartGate = starting.promise;
    w.send('two');
    await waitFor(() => w.adapter.shapeSessions.length === 2);
    await w.engine.stop(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_cold');
    w.adapter.shapeStartGate = null;
    w.overrides = { spec: () => Promise.reject(new Error('no model for planning')) };
    w.send('three');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('ended_error');
    expect(w.engine.view(w.conv.id)).toMatchObject({ queued: 2 });
    expect(getConversation(w.state.db, w.conv.id).providerSessionId).toBe('fake-shape-1');
    expect(w.items().filter((i) => i.kind === 'digest')).toEqual([]);
  });

  it('pushes nothing again under a hold when a stop settles, and does at the release', async () => {
    w = exploreWorld();
    const gates = stoppableTurns(w);
    w.adapter.shapeInterruptReceipt = () => ({ stillQueued: [] });
    w.send('one');
    await waitFor(() => gates.length === 1);
    w.send('two');
    await waitFor(() => w.adapter.shapeSessions[0]?.sent.length === 1);
    w.engine.holdStarts(w.conv.id);
    await w.engine.stop(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_warm');
    expect(w.adapter.shapeSessions[0]?.sent).toEqual(['two']);
    expect(w.engine.busy()).toEqual([]);
    w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Understood.' });
    w.engine.releaseStarts(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions[0]?.sent).toEqual(['two', 'two']);
  });

  it('puts what an end under a hold hands back under Send now', async () => {
    w = exploreWorld();
    const held = gate();
    endingTurn(w, 'error', { before: held.promise });
    w.send('one');
    await waitFor(() => w.engine.live(w.conv.id).items.length === 1);
    w.send('two');
    await waitFor(() => w.adapter.shapeSessions[0]?.sent.length === 1);
    w.engine.holdStarts(w.conv.id);
    held.release();
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('ended_error');
    expect(sendNowLines(w)).toHaveLength(1);
  });

  it('parks what a grace stop under a hold hands back, and runs it at the release', async () => {
    w = exploreWorld();
    const gates = gatedTurns(w);
    w.adapter.shapeInterruptReceipt = () => new Promise(() => undefined);
    w.send('one');
    await waitFor(() => gates.length === 1);
    w.send('two');
    await waitFor(() => w.adapter.shapeSessions[0]?.sent.length === 1);
    w.engine.holdStarts(w.conv.id);
    await w.engine.stop(w.conv.id);
    w.clock.advance(10_000);
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    expect(w.engine.parked(w.conv.id)).toBe(true);
    w.engine.releaseStarts(w.conv.id);
    await waitFor(() => gates.length === 2);
    expect(w.adapter.shapeSessions[1]?.spec.prompt).toBe('two');
    for (const g of gates) g.release();
    await w.engine.settled(w.conv.id);
  });

  it('notes a model change only once the warm session took it', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    w.adapter.shapeModelSwitch = () => Promise.reject(new Error('the model switch failed'));
    await expect(w.engine.modelChanged(w.conv.id, 'claude-sonnet-5-5')).rejects.toThrow(
      'the model switch failed',
    );
    expect(notices(w)).toEqual([]);
    expect(w.engine.view(w.conv.id).model).toBeNull();
  });

  it('starts fresh after a stop a receipt settled past the context limit', async () => {
    w = exploreWorld();
    const held = gate();
    w.adapter.shapeBehaviour = async (turn) => {
      turn.emit({ type: 'context', percentage: 80, totalTokens: 160_000, maxTokens: 200_000 });
      await Promise.race([
        held.promise,
        new Promise((resolve) => {
          turn.signal.addEventListener('abort', resolve);
        }),
      ]);
      await held.promise;
      return {};
    };
    w.adapter.shapeInterruptReceipt = () => ({ stillQueued: [] });
    w.send('one');
    await waitFor(() => getConversation(w.state.db, w.conv.id).contextPct === 80);
    await w.engine.stop(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_cold');
    expect(notices(w)).toEqual([{ text: FRESH_SESSION_NOTICE }]);
    held.release();
  });

  it('keeps the text a failed turn streamed with no message, marked partial', async () => {
    w = exploreWorld();
    w.adapter.shapeBehaviour = (turn) => {
      turn.emit({ type: 'text_delta', itemId: 'cut', offset: 0, text: 'Half a sen' });
      return Promise.reject(new Error('the turn failed'));
    };
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(partials(w)).toEqual([['agent_message', { text: 'Half a sen' }]]);
  });

  it('keeps a partial past the body cap to the cap, and the rest on disk', async () => {
    w = exploreWorld();
    const long = 'x'.repeat(40_000);
    w.adapter.shapeBehaviour = async (turn) => {
      turn.emit({ type: 'text_delta', itemId: 'long', offset: 0, text: long });
      await new Promise((resolve) => {
        turn.signal.addEventListener('abort', resolve);
      });
      return {};
    };
    w.adapter.shapeInterruptReceipt = () => ({ stillQueued: [] });
    w.send('one');
    await waitFor(() => w.engine.live(w.conv.id).items.length === 1);
    await w.engine.stop(w.conv.id);
    await w.engine.settled(w.conv.id);
    const [kept] = w.items().filter((i) => i.partial);
    expect(JSON.stringify(kept?.body).length).toBeLessThanOrEqual(32_768);
    const dir = fullOutputDir(w.dataDir, w.conv.id, kept?.id ?? never());
    expect(readFileSync(join(dir, 'body.txt'), 'utf8')).toBe(long);
  });
});

describe('the commands a session offers', () => {
  it('are stored on the conversation, and read while it is cold', async () => {
    w = exploreWorld();
    w.adapter.shapeBehaviour = (turn) => {
      turn.emit({
        type: 'commands',
        commands: [
          { name: 'compact', description: 'Compact the conversation', argumentHint: '[focus]' },
        ],
      });
      return Promise.resolve({ text: 'Understood.' });
    };
    expect(w.engine.view(w.conv.id).commands).toBeNull();
    w.send('one');
    await w.engine.settled(w.conv.id);
    w.clock.advance(10 * 60_000);
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_cold');
    expect(w.engine.view(w.conv.id).commands).toEqual([
      { name: 'compact', description: 'Compact the conversation', argumentHint: '[focus]' },
    ]);
  });
});

// Sessions spec §7.3: the owner takes what a turn needs just before a message reduces from outside a turn, and is
// told the state after every reduce, so what it took goes back when no turn began.
describe('the owner’s turn hooks', () => {
  const takes = (world: ExploreWorld) =>
    world.hookLog.filter((entry) => entry === 'starting').length;
  const BUSY_STATES = ['starting', 'running', 'waiting_card', 'stopping'];
  /** Whether the log ends with a state report outside a turn, which is when an owner gives back its take. */
  const endsOutsideATurn = (world: ExploreWorld) =>
    !BUSY_STATES.includes(world.hookLog.at(-1)?.replace('state:', '') ?? '');

  it('takes once for a start from idle_cold and reports a state outside a turn at its end', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(takes(w)).toBe(1);
    expect(w.hookLog[0]).toBe('starting');
    expect(w.hookLog.at(-1)).toBe('state:idle_warm');
  });

  it('takes once for a chained turn', async () => {
    w = exploreWorld();
    const gates = gatedTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);
    w.send('two');
    gates[0]?.release();
    await waitFor(() => gates.length === 2);
    gates[1]?.release();
    await w.engine.settled(w.conv.id);
    expect(takes(w)).toBe(1);
    expect(endsOutsideATurn(w)).toBe(true);
  });

  it('takes nothing more when a turn ends in error with starters queued, and reports the state', async () => {
    w = exploreWorld();
    const held = gate();
    endingTurn(w, 'error', { before: held.promise });
    w.send('one');
    await waitFor(() => w.engine.live(w.conv.id).items.length === 1);
    w.send('two');
    held.release();
    await w.engine.settled(w.conv.id);
    // What waits goes under Send now; no second turn began, so no second take.
    expect(w.stateOf()).toBe('ended_error');
    expect(takes(w)).toBe(1);
    expect(w.hookLog.at(-1)).toBe('state:ended_error');
  });

  it('takes nothing for a reduce with nothing queued, and nothing on archive', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    w.hookLog.length = 0;
    await w.engine.retire(w.conv.id);
    expect(takes(w)).toBe(0);
    expect(endsOutsideATurn(w)).toBe(true);
  });

  it('takes once per turn when the next one starts fresh from a digest', async () => {
    w = exploreWorld();
    w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Understood.', contextPercent: 71 });
    w.send('one');
    await w.engine.settled(w.conv.id);
    w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Again.' });
    w.send('two');
    await w.engine.settled(w.conv.id);
    expect(takes(w)).toBe(2);
    expect(endsOutsideATurn(w)).toBe(true);
  });

  it('keeps a session that wrote warm, and its next writing turn reuses it', async () => {
    w = exploreWorld();
    w.writes = true;
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_warm');
    w.send('two');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_warm');
    expect(w.adapter.shapeSessions).toHaveLength(1);
  });

  it('runs a writing turn and a message sent in the middle of it in one session', async () => {
    w = exploreWorld();
    w.writes = true;
    const gates = gatedTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);
    w.send('two');
    gates[0]?.release();
    await waitFor(() => gates.length === 2);
    gates[1]?.release();
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    expect(takes(w)).toBe(1);
  });

  it('closes a warm session opened for the other kind of turn, and keeps the take it just made', async () => {
    w = exploreWorld();
    w.writes = false;
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_warm');
    w.hookLog.length = 0;
    w.writes = true;
    w.send('two');
    await w.engine.settled(w.conv.id);
    // One take, and no state report between it and the new turn: the close did not release it.
    expect(w.hookLog.slice(0, 2)).toEqual(['starting', 'state:starting']);
    expect(w.adapter.shapeSessions).toHaveLength(2);
    // The new session resumes the agent session the old one had.
    expect(w.adapter.shapeSessions[1]?.spec.resumeProviderSessionId).not.toBeNull();
  });
});

describe('sealing a conversation (Do It)', () => {
  const sessionRow = (world: ExploreWorld) => {
    const id = world.adapter.shapeSessions[0]?.spec.sessionId;
    return id === undefined ? undefined : getSession(world.state.db, id);
  };

  it('closes a warm session and ends its row, and the owner hears sealed once', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_warm');
    w.hookLog.length = 0;

    await w.engine.seal(w.conv.id);

    expect(w.stateOf()).toBe('sealed');
    expect(sessionRow(w)?.endedAt).not.toBeNull();
    expect(w.hookLog.filter((line) => line === 'state:sealed')).toHaveLength(1);
  });

  it('stops a running turn and keeps its partial text', async () => {
    w = exploreWorld();
    const gates = gatedTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);

    await w.engine.seal(w.conv.id);

    expect(w.stateOf()).toBe('sealed');
    expect(sessionRow(w)?.endedAt).not.toBeNull();
    expect(w.engine.view(w.conv.id).state).toBe('sealed');
  });

  it('seals a conversation with no session as it is', async () => {
    w = exploreWorld();
    await w.engine.seal(w.conv.id);
    expect(w.stateOf()).toBe('sealed');
    expect(w.adapter.shapeSessions).toHaveLength(0);
  });

  it('refuses a taken-over conversation and leaves what was parked as it was', async () => {
    w = exploreWorld();
    w.state.write((ctx) => {
      patchConversation(ctx, w.conv.id, { state: ConversationState.TakenOver });
    });
    w.engine.holdStarts(w.conv.id);
    w.send('parked');
    expect(w.engine.parked(w.conv.id)).toBe(true);

    await expect(w.engine.seal(w.conv.id)).rejects.toThrow(/Hand back first/);

    expect(w.engine.parked(w.conv.id)).toBe(true);
    expect(w.stateOf()).toBe('taken_over');
  });

  it('stays sealed across a restart, with no session started', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    await w.engine.seal(w.conv.id);

    const next = w.restart();
    await next.engine.recover();

    expect(w.stateOf()).toBe('sealed');
    expect(next.adapter.shapeSessions).toEqual([]);
  });

  it('starts no turn for a message sent to a sealed conversation', async () => {
    w = exploreWorld();
    await w.engine.seal(w.conv.id);
    w.send('later');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('sealed');
    expect(w.adapter.shapeSessions).toHaveLength(0);
  });
});

describe('a chat in the builder’s terminal', () => {
  const takes = (world: ExploreWorld) =>
    world.hookLog.filter((entry) => entry === 'starting').length;
  const HAND_BACK_NOTICE =
    "Turns from your terminal are in the agent's memory; they aren't shown here.";

  /** A conversation with one finished turn, handed to the terminal. */
  async function takenOver(world: ExploreWorld): Promise<void> {
    world.send('one');
    await world.engine.settled(world.conv.id);
    await world.engine.openTerminal(world.conv.id).closed;
  }

  it('closes the session before `closed` settles, and is taken_over', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    const stopping = gate();
    w.adapter.shapeStopGate = stopping.promise;
    const { closed } = w.engine.openTerminal(w.conv.id);
    expect(w.stateOf()).toBe('taken_over');
    let settled = false;
    void closed.then(() => {
      settled = true;
    });
    // Everything that can run has run: the close waits on the stop.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    stopping.release();
    await closed;
    expect(w.engine.view(w.conv.id).state).toBe('taken_over');
  });

  it('refuses a retired chat and leaves its state', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    await w.engine.retire(w.conv.id);
    const before = w.stateOf();
    expect(() => w.engine.openTerminal(w.conv.id)).toThrow(/archived/);
    expect(w.stateOf()).toBe(before);
  });

  it('refuses a busy chat with the state’s words', async () => {
    w = exploreWorld();
    const gates = gatedTurns(w);
    w.send('one');
    await waitFor(() => gates.length === 1);
    expect(() => w.engine.openTerminal(w.conv.id)).toThrow('Stop first');
    gates[0]?.release();
    await w.engine.settled(w.conv.id);
  });

  it('stores a message while taken over, with no take for a turn', async () => {
    w = exploreWorld();
    await takenOver(w);
    w.hookLog.length = 0;
    w.send('held');
    expect(takes(w)).toBe(0);
    expect(w.stateOf()).toBe('taken_over');
    expect(w.engine.view(w.conv.id).queued).toBe(1);
  });

  it('stores a message while paused, with no take for a turn', async () => {
    let blocked: { until: Date | null } | null = null;
    w = exploreWorld({ deps: { accountBlocked: () => blocked } });
    blocked = { until: new Date(w.clock.now().getTime() + RESET_MS) };
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('paused_account');
    w.hookLog.length = 0;
    w.send('two');
    expect(takes(w)).toBe(0);
  });

  it('writes the notice, then runs the held message as one turn', async () => {
    w = exploreWorld();
    await takenOver(w);
    w.send('held');
    w.engine.handBack(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(notices(w)).toContainEqual({ text: HAND_BACK_NOTICE });
    expect(w.adapter.shapeSessions).toHaveLength(2);
    expect(w.adapter.shapeSessions[1]?.spec.prompt).toContain('held');
    expect(w.stateOf()).toBe('idle_warm');
  });

  it('refuses Hand Back for a chat that is not in the terminal', () => {
    w = exploreWorld();
    expect(() => {
      w.engine.handBack(w.conv.id);
    }).toThrow('Not in your terminal');
  });

  it('parks the held message under held starts, and runs it once at the release', async () => {
    w = exploreWorld();
    await takenOver(w);
    w.send('held');
    w.engine.holdStarts(w.conv.id);
    w.engine.handBack(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_cold');
    expect(w.adapter.shapeSessions).toHaveLength(1);
    expect(w.engine.parked(w.conv.id)).toBe(true);
    expect(w.engine.releaseStarts(w.conv.id)).toBe(true);
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions).toHaveLength(2);
    expect(w.engine.parked(w.conv.id)).toBe(false);
  });

  it('parks the queue an account’s return runs under the update hold', async () => {
    let blocked: { until: Date | null } | null = null;
    let holding = true;
    let clear: (cleared: boolean) => void = () => undefined;
    w = exploreWorld({
      deps: {
        accountBlocked: () => blocked,
        hold: {
          holding: () => holding,
          untilClear: () =>
            new Promise<boolean>((resolve) => {
              clear = resolve;
            }),
        },
      },
    });
    holding = false;
    blocked = { until: new Date(w.clock.now().getTime() + RESET_MS) };
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('paused_account');
    holding = true;
    blocked = null;
    w.clock.advance(RESET_MS);
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions).toEqual([]);
    holding = false;
    clear(true);
    await waitFor(() => w.adapter.shapeSessions.length === 1);
    await w.engine.settled(w.conv.id);
  });

  it('gives the chat back with no notice, and runs its queue, when the terminal failed', async () => {
    w = exploreWorld();
    await takenOver(w);
    w.send('held');
    w.engine.terminalFailed(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(notices(w)).not.toContainEqual({ text: HAND_BACK_NOTICE });
    expect(w.adapter.shapeSessions).toHaveLength(2);
  });

  it('stays taken over through a restart, with no Send now, and runs the held message once at Hand Back', async () => {
    w = exploreWorld();
    await takenOver(w);
    w.send('held');
    const again = w.restart();
    await again.engine.recover();
    expect(again.engine.view(w.conv.id).state).toBe('taken_over');
    expect(w.items().filter((i) => i.kind === 'turn_marker')).toEqual([]);
    again.engine.handBack(w.conv.id);
    await again.engine.settled(w.conv.id);
    expect(again.adapter.shapeSessions).toHaveLength(1);
    expect(again.adapter.shapeSessions[0]?.spec.prompt).toContain('held');
    await again.engine.close();
  });
});
