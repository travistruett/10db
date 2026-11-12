import { InvalidError } from '@10db/contracts';
import { insertSession } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { silentLogger } from '../log';
import { passKeptRef } from '../pass';
import { createToolHandlers } from './tools';

// Workbench spec §6.2: the commit tool is rerouted in a pass. A pass lane's page paths go to its
// task's kept commit; the pass's branch never moves, and shared code is refused until shared areas.

let w: PassWorld;
afterEach(() => {
  w.close();
});

/** The settings lane's tool handlers, as its session's MCP server builds them. */
function settingsTools(world: PassWorld) {
  const workstreamId = world.runOf(world.settings);
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
    },
    session.id,
    workstreamId,
  );
}

describe('the commit tool in a pass lane', () => {
  it("keeps the page's paths at the task's ref, unsigned, and never moves the pass's branch", async () => {
    w = await openPassWorld();
    const tools = settingsTools(w);
    const tip = w.h.git$('rev-parse', 'HEAD');
    w.write('src/settings/page.tsx', 'settings\nedited\n');

    const first = await tools.commit({
      opId: 'op-pass-1',
      paths: ['src/settings/page.tsx'],
      message: 'Edit settings',
    });

    const ref = passKeptRef(w.opened.pass.id, w.settings.id);
    expect(first).toEqual({ sha: w.h.git$('rev-parse', ref), alreadyCommitted: false });
    expect(w.h.git$('show', `${ref}:src/settings/page.tsx`)).toBe('settings\nedited');
    expect(w.h.git$('log', '-1', '--format=%G?', ref)).toBe('N');
    expect(w.h.git$('rev-parse', 'HEAD')).toBe(tip);
    expect(w.h.git$('rev-parse', w.branch)).toBe(tip);
    // A retry with the same opId answers the same commit.
    expect(
      await tools.commit({
        opId: 'op-pass-1',
        paths: ['src/settings/page.tsx'],
        message: 'Edit settings',
      }),
    ).toEqual(first);
  });

  it("refuses shared code and another page's file, and keeps nothing", async () => {
    w = await openPassWorld();
    const tools = settingsTools(w);
    w.write('src/shared.ts', 'a shared edit\n');
    w.write('src/people/page.tsx', "a neighbour's edit\n");

    await expect(
      tools.commit({ opId: 'op-pass-2', paths: ['src/shared.ts'], message: 'Shared' }),
    ).rejects.toThrow(/shared code needs request_claim/);
    await expect(
      tools.commit({ opId: 'op-pass-3', paths: ['src/people/page.tsx'], message: 'People' }),
    ).rejects.toThrow(InvalidError);
    expect(w.h.git$('for-each-ref', 'refs/10db/passes/')).not.toContain(w.settings.id);
  });
});
