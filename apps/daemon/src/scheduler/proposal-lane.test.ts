import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ClaimKind, WorkstreamState, type WorkstreamId } from '@10db/contracts';
import {
  activeClaims,
  createTestStore,
  getTask,
  getWorkstream,
  insertInboxItem,
  insertProposal,
  insertSource,
  listInbox,
  listTasks,
  seedProject,
  transitionWorkstream,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, seedWorkstream } from '../../test/fixtures';
import { createAccountPauses, createAccountRuntime } from '../accounts';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore } from '../events';
import { createGit } from '../git';
import { createInboxService } from '../inbox';
import { silentLogger } from '../log';
import { seedTeam, startTaskWithPlan } from '../team';
import { createWatcher, type WatchFn } from '../watcher';
import { createScheduler } from './index';

/**
 * A lane for a task the builder accepted from a proposal raised in another lane: the filed task carries
 * the raising task's areas, the scheduler acquires them as the lane leaves QUEUED, and the watcher then
 * finds no write in that area outside every claim. Each half is pinned elsewhere; this pins them together,
 * so a change to either one fails here.
 */
describe('a lane for a task filed from a proposal', () => {
  let close: () => void;
  let repo: { path: string; cleanup(): void };
  let watcher: ReturnType<typeof createWatcher>;

  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    watcher.stop();
    close();
    repo.cleanup();
  });

  it('holds its area claim in STARTING before any write, and a write in that area raises no stray card', async () => {
    const test = createTestStore();
    close = test.close;
    const store = test.store;
    const bus = createEventBus();
    const state = createStateStore(store, bus);
    const clock = new ManualClock(new Date(2026, 9, 31, 12));
    seedTeam(state, readDefaultPersonas());
    const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
    const pauses = createAccountPauses({
      state,
      clock,
      inbox,
      stopAccount: () => Promise.resolve(),
      onResume: () => undefined,
    });
    const accounts = createAccountRuntime({ state, clock, inbox, pauses, defaultPauseMs: 60_000 });
    const project = seedProject(store, { repoPath: repo.path });

    // The lane that raises the proposal works in the api area, then is done with the checkout.
    const raiser = seedWorkstream(store, { project, title: 'Raiser', areas: ['api'] });
    state.write((ctx) =>
      transitionWorkstream(ctx, raiser.workstream.id, {
        to: WorkstreamState.Cancelled,
        fence: null,
      }),
    );

    // The raiser proposes a task by the same route as the propose tool: an agent source naming its lane.
    const proposalId = state.write((ctx) =>
      insertProposal(ctx, {
        projectId: project.id,
        kind: 'new_task',
        title: 'Follow up',
        body: 'Do the follow-up.',
        sourceId: insertSource(ctx, 'agent', { workstreamId: raiser.workstream.id }),
      }),
    );
    const card = state.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: project.id,
        kind: 'proposal',
        title: 'Follow up',
        body: 'Do the follow-up.',
        options: [
          { label: 'accept', description: '' },
          { label: 'reject', description: '' },
        ],
        recommendation: null,
        category: 'product',
        urgency: 'low',
        detail: { proposalId },
        foldKey: null,
        targets: [],
      }),
    );
    inbox.answer(card.id, { choice: 'accept' });
    const filed = listTasks(state.db, project.id).find((t) => t.title === 'Follow up');
    if (!filed) throw new Error('expected the accepted proposal to file a task');
    expect(getTask(state.db, filed.id).areas).toEqual(['api']);

    // The builder starts it: a QUEUED lane, which holds nothing until the scheduler launches it.
    const lane = startTaskWithPlan(state, filed.id);
    const launched: WorkstreamId[] = [];
    const scheduler = createScheduler({
      state,
      clock,
      caps: { global: 4 },
      instanceId: 'daemon-1',
      leaseMs: 60_000,
      tickMs: 2_000,
      logger: silentLogger,
      runner: {
        launch: (id) => {
          launched.push(id);
        },
        isRunning: () => false,
      },
      accounts: { ...accounts, prepare: () => undefined },
      branches: { currentBranch: () => Promise.resolve(null) },
      onWrongBranch: () => undefined,
      onWorktreeMissing: () => undefined,
    });
    expect(activeClaims(state.db, lane.id)).toEqual([]);
    expect(await scheduler.tick()).toBe(1);

    // The claim is held the moment the lane is STARTING, before the session could write anything.
    expect(launched).toEqual([lane.id]);
    expect(getWorkstream(state.db, lane.id).state).toBe(WorkstreamState.Starting);
    expect(activeClaims(state.db, lane.id).map((c) => [c.kind, c.name])).toEqual([
      [ClaimKind.Area, 'api'],
    ]);

    const open = new Map<string, (rel: string) => void>();
    const watch: WatchFn = (root, onChange) => {
      open.set(root, onChange);
      return { close: () => open.delete(root) };
    };
    watcher = createWatcher({
      state,
      bus,
      inbox,
      git: createGit(),
      logger: silentLogger,
      clock,
      watch,
      batchMs: 500,
    });
    watcher.sync();
    expect([...open.keys()]).toEqual([repo.path]);
    const write = (rel: string) => {
      mkdirSync(dirname(join(repo.path, rel)), { recursive: true });
      writeFileSync(join(repo.path, rel), 'x');
      open.get(repo.path)?.(rel);
    };
    const strays = () =>
      listInbox(state.db, { states: ['OPEN'] }).filter(
        (i) => i.kind === 'flag' && i.title === 'Write outside every claim',
      );

    write('src/api/handler.ts');
    clock.advance(500);
    await watcher.flush();
    expect(strays()).toEqual([]);

    // The watcher is looking: a write in an area the lane doesn't hold is still flagged.
    write('src/ui/page.ts');
    clock.advance(500);
    await watcher.flush();
    expect(strays().map((i) => i.body)).toEqual(['src/ui/page.ts']);
  });
});
