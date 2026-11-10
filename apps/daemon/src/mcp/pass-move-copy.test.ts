import {
  ClaimKind,
  PASS_MOVE_TO_COPY_CHOICE,
  PASS_NOT_NOW_CHOICE,
  PassMoveToCopyDetail,
  WorkspaceMode,
  WorkstreamState,
  type TaskDto,
} from '@10db/contracts';
import {
  activeClaims,
  getBatch,
  getInboxItem,
  getTask,
  getWorkstreamRow,
  insertSession,
  listTaskThread,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { silentLogger } from '../log';
import { answerMoveToCopy } from '../pass';
import { ClaimWaits } from './claim-wait';
import { createToolHandlers } from './tools';

// Workbench spec §8.4: a pass task that asks for the migrations or deps hazard where the project
// allows copies is not granted it in Your folder; the builder gets one card, Move to a Separate Copy,
// which takes the task out and starts it in a copy. A project with no copies grants it as today.

let w: PassWorld;
afterEach(() => {
  w.close();
});

/** The task's lane tools, as its session's MCP server builds them, in a turn. */
function laneTools(world: PassWorld, task: TaskDto) {
  const workstreamId = world.runOf(task);
  world.startTurn(task);
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
    },
    session.id,
    workstreamId,
    new ClaimWaits(),
  );
}

const hazardsHeld = (world: PassWorld, task: TaskDto): string[] =>
  activeClaims(world.h.store.db, world.runOf(task))
    .filter((c) => c.kind === ClaimKind.Hazard)
    .map((c) => c.name);

describe('a pass lane asking for the deps hazard', () => {
  it('is refused where copies are allowed, with one card per task offering the move', async () => {
    w = await openPassWorld();
    const tools = laneTools(w, w.settings);

    const first = await tools.request_claim({
      opId: 'op-deps-1',
      kind: 'hazard',
      name: 'deps',
      reason: 'add a date library',
    });
    const again = await tools.request_claim({
      opId: 'op-deps-2',
      kind: 'hazard',
      name: 'deps',
      reason: 'add it after all',
    });

    expect(first.granted).toBe(false);
    if (first.granted || again.granted) throw new Error('deps was granted in the folder');
    expect(first.waiting).toBe(false);
    expect(first.inboxId).not.toBeNull();
    expect(again.inboxId).toBe(first.inboxId);
    expect(hazardsHeld(w, w.settings)).toEqual([]);
    if (first.inboxId === null) throw new Error('no card');
    const card = getInboxItem(w.h.store.db, first.inboxId);
    expect(PassMoveToCopyDetail.parse(card.detail)).toEqual({
      kind: 'pass_move_to_copy',
      passId: w.opened.pass.id,
      taskId: w.settings.id,
      workstreamId: w.runOf(w.settings),
      hazard: 'deps',
    });
    expect(card.options.map((o) => o.label)).toEqual([
      PASS_MOVE_TO_COPY_CHOICE,
      PASS_NOT_NOW_CHOICE,
    ]);
    // The page's thread says so once, for the card, not once per ask.
    expect(
      listTaskThread(w.h.store.db, w.settings.id)
        .map((m) => m.body)
        .filter((body) => body.includes('Move to a Separate Copy')),
    ).toEqual([
      'The agent asked for the deps hazard, which runs in a separate copy: "Move to a Separate Copy" waits in the Inbox.',
    ]);
  });

  it('is granted as today on a project with no copies, and the thread says the page will be slow', async () => {
    w = await openPassWorld({ project: { delivery: 'local' } });
    const tools = laneTools(w, w.settings);

    const answer = await tools.request_claim({
      opId: 'op-deps-1',
      kind: 'hazard',
      name: 'deps',
      reason: 'add a date library',
    });

    expect(answer.granted).toBe(true);
    expect(hazardsHeld(w, w.settings)).toEqual(['deps']);
    expect(w.h.cards()).toEqual([]);
    expect(listTaskThread(w.h.store.db, w.settings.id).at(-1)?.body).toMatch(
      /deps .*Your folder.*slow/,
    );
  });
});

describe("the Move to a Separate Copy card's answer", () => {
  it('takes the task out of the pass and starts it in a separate copy', async () => {
    w = await openPassWorld();
    const tools = laneTools(w, w.settings);
    const refused = await tools.request_claim({
      opId: 'op-deps-1',
      kind: 'hazard',
      name: 'deps',
      reason: 'add a date library',
    });
    if (refused.granted || refused.inboxId === null) throw new Error('no card');
    const card = getInboxItem(w.h.store.db, refused.inboxId);
    const taken = w.runOf(w.settings);

    await answerMoveToCopy(
      {
        ...w.deps,
        stopLane: () => Promise.resolve(),
        wrote: () => Promise.resolve(),
        startInCopy: (taskId) => {
          w.h.starter.startTask(taskId);
        },
      },
      card,
      { choice: PASS_MOVE_TO_COPY_CHOICE },
    );
    await w.h.jobs.idle();

    const task = getTask(w.h.store.db, w.settings.id);
    expect(task.passId ?? null).toBeNull();
    expect(task.workspaceMode).toBe(WorkspaceMode.Worktree);
    expect(task.placementReason).toBe('touches deps');
    expect(getWorkstreamRow(w.h.store.db, taken).state).toBe(WorkstreamState.Cancelled);
    expect(task.workstreamId).not.toBe(taken);
    if (task.workstreamId === null) throw new Error('not started');
    const run = getWorkstreamRow(w.h.store.db, task.workstreamId);
    if (run.batchId === null) throw new Error('no batch');
    expect(getBatch(w.h.store.db, run.batchId).passId ?? null).toBeNull();
  });

  it('leaves the task in the pass on Not Now', async () => {
    w = await openPassWorld();
    const tools = laneTools(w, w.settings);
    const refused = await tools.request_claim({
      opId: 'op-deps-1',
      kind: 'hazard',
      name: 'deps',
      reason: 'add a date library',
    });
    if (refused.granted || refused.inboxId === null) throw new Error('no card');
    const run = w.runOf(w.settings);

    await answerMoveToCopy(
      {
        ...w.deps,
        stopLane: () => Promise.resolve(),
        wrote: () => Promise.resolve(),
        startInCopy: () => {
          throw new Error('started');
        },
      },
      getInboxItem(w.h.store.db, refused.inboxId),
      { choice: PASS_NOT_NOW_CHOICE },
    );

    expect(getTask(w.h.store.db, w.settings.id).passId).toBe(w.opened.pass.id);
    expect(w.runOf(w.settings)).toBe(run);
  });

  it('asks no more after Not Now: a later ask is refused with no new card', async () => {
    w = await openPassWorld();
    const tools = laneTools(w, w.settings);
    const refused = await tools.request_claim({
      opId: 'op-deps-1',
      kind: 'hazard',
      name: 'deps',
      reason: 'add a date library',
    });
    if (refused.granted || refused.inboxId === null) throw new Error('no card');
    w.h.inbox.answer(refused.inboxId, { choice: PASS_NOT_NOW_CHOICE });

    const again = await tools.request_claim({
      opId: 'op-deps-2',
      kind: 'hazard',
      name: 'deps',
      reason: 'add it after all',
    });

    if (again.granted) throw new Error('deps was granted in the folder');
    expect(again.inboxId).toBe(refused.inboxId);
    expect(again.instruction).toMatch(/builder chose Not Now/);
    expect(w.h.cards()).toEqual([]);
    expect(hazardsHeld(w, w.settings)).toEqual([]);
  });
});
