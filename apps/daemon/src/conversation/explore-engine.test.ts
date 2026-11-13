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
