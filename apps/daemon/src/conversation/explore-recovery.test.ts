import {
  ConflictError,
  ConversationItemAuthor,
  ConversationItemKind,
  type ConversationState,
} from '@10db/contracts';
import { insertInboxItem, insertItem, patchConversation } from '@10db/db';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { exploreWorld, gate, type ExploreWorld } from '../../test/explore-world';
import { waitFor } from '../../test/fixtures';
import { INTERRUPTED_NOTICE } from './explore-recovery';

// Sessions spec §6.3, §6.4, §6.7 (the restart row): a restart is a second engine over the same store,
// with its own fake adapter and clock. A clean stop closes the first; a crash drops it.

let w: ExploreWorld;
afterEach(async () => {
  await w.engine.close();
  w.close();
});

const TurnMarkerBody = z.object({ resolvedAt: z.string().nullable() });
const markers = (world: ExploreWorld) => world.items().filter((i) => i.kind === 'turn_marker');
const notices = (world: ExploreWorld) =>
  world
    .items()
    .filter((i) => i.kind === 'notice')
    .map((i) => i.body);
const partialTexts = (world: ExploreWorld) =>
  world
    .items()
    .filter((i) => i.partial)
    .map((i) => i.body);

/** Turns that stream half a sentence and wait. */
function hangingTurns(world: ExploreWorld) {
  let begun = 0;
  world.adapter.shapeBehaviour = async (turn) => {
    begun += 1;
    turn.emit({
      type: 'text_delta',
      itemId: `half-${String(turn.number)}`,
      offset: 0,
      text: 'Half a sen',
    });
    await new Promise(() => undefined);
    return {};
  };
  return () => begun;
}

async function restarted(world: ExploreWorld, how: 'clean' | 'crash') {
  if (how === 'clean') await world.engine.close();
  const next = world.restart();
  await next.engine.recover();
  await next.engine.settled(world.conv.id);
  return next;
}

describe('the restart row', () => {
  it('cools a warm conversation and sends nothing', async () => {
    w = exploreWorld();
    w.send('one');
    await w.engine.settled(w.conv.id);
    const next = await restarted(w, 'crash');
    expect(w.stateOf()).toBe('idle_cold');
    expect(markers(w)).toEqual([]);
    expect(next.adapter.shapeSessions).toEqual([]);
  });

  it('keeps two messages queued while starting under one Send now, and sends nothing', async () => {
    w = exploreWorld();
    w.specGate = new Promise(() => undefined);
    w.send('one');
    w.send('two');
    await waitFor(() => w.starts.length === 1);
    const next = await restarted(w, 'crash');
    expect(w.stateOf()).toBe('idle_cold');
    expect(markers(w)).toHaveLength(1);
    expect(w.engine.view(w.conv.id)).toMatchObject({ queued: 2, sendNow: true });
    expect(next.adapter.shapeSessions).toEqual([]);
    expect(next.engine.busy()).toEqual([]);
  });

  it.each([
    ['a clean close', 'clean', [{ text: 'Half a sen' }], []],
    ['a crash', 'crash', [], [{ text: INTERRUPTED_NOTICE }]],
  ] as const)(
    'after %s mid-turn, cools the conversation under Send now',
    async (_n, how, partial, said) => {
      w = exploreWorld();
      const begun = hangingTurns(w);
      w.send('one');
      await waitFor(() => begun() === 1 && w.engine.live(w.conv.id).items.length === 1);
      const next = await restarted(w, how);
      expect(w.stateOf()).toBe('idle_cold');
      expect(partialTexts(w)).toEqual(partial);
      expect(notices(w)).toEqual(said);
      expect(markers(w)).toHaveLength(1);
      expect(next.adapter.shapeSessions).toEqual([]);
    },
  );

  it('withdraws the card a crashed turn waited on, and says the turn was interrupted', async () => {
    const withdrawn: string[] = [];
    w = exploreWorld({ deps: { withdrawCard: (id) => void withdrawn.push(id) } });
    const begun = hangingTurns(w);
    w.send('one');
    await waitFor(() => begun() === 1);
    const card = w.state.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: w.project.id,
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
    w.starts[0]?.observer.onWaitStart(card);
    w.send('two');
    expect(w.stateOf()).toBe('waiting_card');
    // The first engine has pushed what it injected before it dies.
    await waitFor(() => w.adapter.shapeSessions[0]?.sent.length === 1);
    withdrawn.length = 0;
    await restarted(w, 'crash');
    expect(withdrawn).toEqual([card.id]);
    expect(notices(w)).toEqual([{ text: INTERRUPTED_NOTICE }]);
    expect(w.stateOf()).toBe('idle_cold');
    expect(markers(w)).toHaveLength(1);
  });

  it('cools a stopping conversation, saying the turn was interrupted', async () => {
    w = exploreWorld();
    const begun = hangingTurns(w);
    w.adapter.shapeInterruptReceipt = () => new Promise(() => undefined);
    w.send('one');
    await waitFor(() => begun() === 1);
    await w.engine.stop(w.conv.id);
    expect(w.stateOf()).toBe('stopping');
    await restarted(w, 'crash');
    expect(w.stateOf()).toBe('idle_cold');
    expect(notices(w)).toEqual([{ text: INTERRUPTED_NOTICE }]);
  });

  it.each(['taken_over', 'paused_account'] as const)('leaves %s as it is', async (held) => {
    w = exploreWorld();
    w.state.write((ctx) => {
      patchConversation(ctx, w.conv.id, { state: held });
    });
    const next = await restarted(w, 'crash');
    expect(w.stateOf()).toBe(held);
    expect(next.adapter.shapeSessions).toEqual([]);
  });

  it('leaves an errored conversation under its one Send now line', async () => {
    w = exploreWorld();
    w.adapter.shapeStartFailure = () => ({ reason: 'error', message: 'broken' });
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('ended_error');
    w.state.write((ctx) => {
      insertItem(ctx, w.conv.id, {
        author: ConversationItemAuthor.Builder,
        kind: ConversationItemKind.Message,
        body: { text: 'two' },
      });
    });
    await restarted(w, 'crash');
    w.restart();
    await w.engine.recover();
    expect(w.stateOf()).toBe('ended_error');
    expect(markers(w)).toHaveLength(1);
  });
});

describe('Send now', () => {
  async function waitingTwo(): Promise<void> {
    w = exploreWorld();
    w.specGate = new Promise(() => undefined);
    w.send('one');
    w.send('two');
    await waitFor(() => w.starts.length === 1);
    w.specGate = null;
    await restarted(w, 'crash');
  }

  it('sends every waiting message in seq order in one turn, and resolves the line', async () => {
    await waitingTwo();
    w.engine.sendNow(w.conv.id);
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions.map((s) => s.spec.prompt)).toEqual(['one\n\ntwo']);
    expect(markers(w).map((m) => TurnMarkerBody.parse(m.body).resolvedAt)).not.toContain(null);
    expect(w.engine.view(w.conv.id).sendNow).toBe(false);
  });

  it('does the same for a new message, which joins them', async () => {
    await waitingTwo();
    w.send('three');
    await w.engine.settled(w.conv.id);
    expect(w.adapter.shapeSessions.map((s) => s.spec.prompt)).toEqual(['one\n\ntwo\n\nthree']);
    expect(w.engine.view(w.conv.id).sendNow).toBe(false);
  });

  it.each(['paused_account', 'taken_over', 'starting'] as const)(
    'is refused while %s, and the line stays',
    async (held: ConversationState) => {
      await waitingTwo();
      w.state.write((ctx) => {
        patchConversation(ctx, w.conv.id, { state: held });
      });
      w.restart();
      expect(() => {
        w.engine.sendNow(w.conv.id);
      }).toThrow(ConflictError);
      expect(w.engine.view(w.conv.id).sendNow).toBe(true);
      expect(w.adapter.shapeSessions).toEqual([]);
    },
  );

  it('waits out a pause found at the restart, then waits under Send now instead of running', async () => {
    let blocked: { until: Date | null } | null = { until: null };
    w = exploreWorld({ deps: { accountBlocked: () => blocked } });
    w.send('one');
    await w.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('paused_account');
    const next = w.restart({ accountBlocked: () => blocked });
    await next.engine.recover();
    blocked = null;
    next.clock.advance(30 * 60_000);
    await next.engine.settled(w.conv.id);
    expect(w.stateOf()).toBe('idle_cold');
    expect(markers(w)).toHaveLength(1);
    expect(next.adapter.shapeSessions).toEqual([]);
  });
});

describe('read-back (rule 5)', () => {
  it.each([
    ['takes a message the agent’s conversation holds, and sends it no more', true],
    ['hands back a message on an agent with no read-back, under Send now', false],
  ] as const)('%s', async (_name, readBack) => {
    w = exploreWorld();
    const held = gate();
    w.adapter.shapeBehaviour = async () => {
      await held.promise;
      return {};
    };
    const message = w.send('one');
    await waitFor(() => w.stateOf() === 'running');
    const uuid = w.adapter.shapeSessions[0]?.spec.promptUuid ?? '';
    const next = w.restart();
    next.adapter.capabilityOverrides = { readBack };
    next.adapter.readBack = () => Promise.resolve([uuid]);
    await next.engine.recover();
    const row = w.items().find((i) => i.id === message.id);
    if (readBack) {
      expect(row?.deliveredAt).not.toBeNull();
      expect(markers(w)).toEqual([]);
    } else {
      expect(row).toMatchObject({ pushedAt: null, deliveredAt: null });
      expect(markers(w)).toHaveLength(1);
    }
    expect(next.adapter.shapeSessions).toEqual([]);
  });
});
