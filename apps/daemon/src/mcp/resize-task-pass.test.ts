import { insertSession } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { silentLogger } from '../log';
import { createToolHandlers } from './tools';

// A Workbench page runs no rigor's steps, so its agent can't resize it.

let w: PassWorld;
afterEach(() => {
  w.close();
});

describe('resize_task on a Workbench page', () => {
  it('is refused as a result the agent reads, and changes nothing', async () => {
    w = await openPassWorld();
    const workstreamId = w.runOf(w.settings);
    const session = w.h.state.write((ctx) =>
      insertSession(ctx, {
        workstreamId,
        provider: 'claude',
        model: 'sonnet',
        effort: 'medium',
        mode: 'managed',
        mcpTokenHash: 'hash',
      }),
    );
    const tools = createToolHandlers(
      {
        protectedPaths: [],
        state: w.h.state,
        inbox: w.h.inbox,
        git: w.h.git,
        log: silentLogger,
        waitObserverFor: () => undefined,
        sessionSignal: () => undefined,
        askedToHandOff: () => undefined,
      },
      session.id,
      workstreamId,
    );
    const result = await tools.resize_task({
      opId: 'op-resize-pg',
      rigor: 'critical',
      why: 'A big page',
    });
    expect(result).toMatchObject({
      resized: false,
      message: expect.stringContaining('A Workbench page runs no rigor') as string,
    });
    expect(w.h.cards()).toEqual([]);
  });
});
