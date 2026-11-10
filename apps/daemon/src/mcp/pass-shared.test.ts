import type { TaskDto } from '@10db/contracts';
import { getHold, insertSession, listSharedChanges, openHolds } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { silentLogger } from '../log';
import { closeHoldsOf, landSharedChanges, sharedRef } from '../pass';
import { ClaimWaits } from './claim-wait';
import { createToolHandlers } from './tools';

// Workbench spec §7.2: a pass lane asks for a shared area with request_claim, and gets it for the
// turn with a hold that records what the area held at the grant.

let w: PassWorld;
afterEach(() => {
  w.close();
});

/** The task's lane tools, as its session's MCP server builds them, sharing `waits`. */
function laneTools(world: PassWorld, task: TaskDto, waits: ClaimWaits, sliceMs?: number) {
  const workstreamId = world.runOf(task);
  const session = world.h.state.write((ctx) =>
    insertSession(ctx, {
      workstreamId,
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: 'hash',
    }),
  );
  return createToolHandlers(
    {
      protectedPaths: [],
      state: world.h.state,
      inbox: world.h.inbox,
      git: world.h.git,
      log: silentLogger,
      waitObserverFor: () => undefined,
      sessionSignal: () => undefined,
      askedToHandOff: () => undefined,
      claimPollMs: 10,
      ...(sliceMs === undefined ? {} : { claimWaitSliceMs: sliceMs }),
    },
    session.id,
    workstreamId,
    waits,
  );
}

describe('request_claim for a shared area in a pass', () => {
  it('grants the first task the area with its hold', async () => {
    w = await openPassWorld();
    const tools = laneTools(w, w.settings, new ClaimWaits());

    const answer = await tools.request_claim({
      opId: 'op-src-1',
      kind: 'area',
      name: 'src',
      reason: 'a shared button',
    });

    expect(answer.granted).toBe(true);
    const holds = openHolds(w.h.store.db, w.opened.pass.id);
    expect(holds).toHaveLength(1);
    expect(answer).toEqual({ granted: true, claimId: holds[0]?.claimId });
  });
});

describe('the commit tool under a shared hold', () => {
  it('keeps shared paths on the chain early, the turn end keeps them again, and they land', async () => {
    w = await openPassWorld();
    const { h } = w;
    const tools = laneTools(w, w.settings, new ClaimWaits());
    const granted = await tools.request_claim({
      opId: 'op-src-1',
      kind: 'area',
      name: 'src',
      reason: 'a shared button',
    });
    if (!granted.granted) throw new Error('src was not granted');
    w.write('src/button.ts', 'button\n');

    const early = await tools.commit({
      opId: 'op-c-1',
      paths: ['src/button.ts'],
      message: 'Button',
    });

    const chain = sharedRef(w.opened.pass.id);
    expect(early).toEqual({ sha: h.git$('rev-parse', chain), alreadyCommitted: false });
    expect(h.git$('rev-parse', 'HEAD')).toBe(w.opened.pass.startSha);
    expect(getHold(h.store.db, granted.claimId).closedAt).toBeNull();
    expect(listSharedChanges(h.store.db, w.opened.pass.id)[0]?.sha).toBe(early.sha);

    w.write('src/button.ts', 'button, edited after the commit\n');
    await closeHoldsOf(w.deps, w.runOf(w.settings));

    const [change] = listSharedChanges(h.store.db, w.opened.pass.id);
    expect(change?.sha).not.toBe(early.sha);
    expect(change?.sha).toBe(h.git$('rev-parse', chain));
    expect(h.git$('rev-parse', `${chain}^`)).toBe(early.sha);
    expect(getHold(h.store.db, granted.claimId).closedAt).not.toBeNull();
    await landSharedChanges(w.deps, { passId: w.opened.pass.id, upTo: 1 });
    expect(h.git$('show', `${w.branch}:src/button.ts`)).toBe('button, edited after the commit');
    expect(h.git$('log', '-1', '--format=%s', w.branch)).toBe(
      'Shared change 1 of Settings: UI work',
    );
  });
});
