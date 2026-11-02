import { AccountPauseReason, type AccountId } from '@10db/contracts';
import {
  createTestStore,
  getProject,
  getWorkstream,
  listInbox,
  seedAccount,
  seedProject,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService } from '../inbox';
import { createAccountPauses, type AccountCard } from './index';

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let stopped: AccountId[];
let resumed: number;

beforeEach(() => {
  clock = new ManualClock();
  ({ store, close } = createTestStore(() => clock.now()));
  state = createStateStore(store, createEventBus());
  stopped = [];
  resumed = 0;
});
afterEach(() => {
  close();
});

function pauses() {
  return createAccountPauses({
    state,
    clock,
    inbox: createInboxService({ state, onParkedAnswer: () => undefined }),
    stopAccount: (id) => {
      stopped.push(id);
      return Promise.resolve();
    },
    onResume: () => {
      resumed += 1;
    },
  });
}
const card = (id: AccountId, kind: string): AccountCard => ({
  title: 'paused',
  body: 'body',
  foldKey: `account:${id}:${kind}`,
  detail: {},
});
const inMinutes = (n: number) => new Date(clock.now().getTime() + n * 60_000);
/** A workstream of `project` left in PAUSED_LIMIT. */
function pausedWork(project = seedProject(store)) {
  const { workstream } = seedWorkstream(store, { project });
  state.write((ctx) => {
    transitionWorkstream(ctx, workstream.id, { to: 'STARTING', fence: null });
    transitionWorkstream(ctx, workstream.id, { to: 'PAUSED_LIMIT', fence: null });
  });
  return workstream;
}

describe('account pauses', () => {
  it('pauses for a usage limit once, raises one card, stops the account, and re-queues its work at the reset', () => {
    const work = pausedWork();
    const accountId = getProject(state.db, work.projectId).accountId;
    const p = pauses();
    const reset = inMinutes(10);
    const at = { projectId: work.projectId, card: card(accountId, 'usage_limit') };
    p.pause(accountId, { reason: AccountPauseReason.UsageLimit, until: reset }, at);
    p.pause(accountId, { reason: AccountPauseReason.UsageLimit, until: reset }, at);
    expect(p.pausedFor(accountId)).toEqual({
      reason: 'usage_limit',
      until: reset,
      since: clock.now(),
    });
    expect(stopped).toEqual([accountId, accountId]);
    expect(listInbox(state.db, { states: ['OPEN'] })).toHaveLength(1);
    clock.advance(10 * 60_000);
    expect(p.pausedFor(accountId)).toBeNull();
    expect(getWorkstream(state.db, work.id).state).toBe('QUEUED');
    expect(resumed).toBe(1);
  });

  it("re-queues only the paused account's work", () => {
    const key = seedAccount(store, { kind: 'anthropic_api_key', label: 'Client key' });
    const mine = pausedWork(seedProject(store, { accountId: key.id }));
    const other = pausedWork();
    const p = pauses();
    p.pause(
      key.id,
      { reason: AccountPauseReason.Refused, until: null },
      { projectId: mine.projectId, card: card(key.id, 'refused') },
    );
    p.resume(key.id);
    expect(getWorkstream(state.db, mine.id).state).toBe('QUEUED');
    expect(getWorkstream(state.db, other.id).state).toBe('PAUSED_LIMIT');
  });

  it('keeps a pause with no end over one that ends, and the later of two ends', () => {
    const key = seedAccount(store, { kind: 'anthropic_api_key', label: 'Client key' });
    const projectId = seedProject(store, { accountId: key.id }).id;
    const p = pauses();
    const at = { projectId, card: card(key.id, 'x') };
    p.pause(key.id, { reason: AccountPauseReason.UsageLimit, until: inMinutes(20) }, at);
    p.pause(key.id, { reason: AccountPauseReason.UsageLimit, until: inMinutes(5) }, at);
    expect(p.pausedFor(key.id)?.until).toEqual(inMinutes(20));
    p.pause(key.id, { reason: AccountPauseReason.Refused, until: null }, at);
    p.pause(key.id, { reason: AccountPauseReason.UsageLimit, until: inMinutes(60) }, at);
    expect(p.pausedFor(key.id)).toEqual({ reason: 'refused', until: null, since: clock.now() });
    clock.advance(120 * 60_000);
    expect(p.pausedFor(key.id)?.reason).toBe('refused');
    expect(stopped).toEqual([key.id, key.id, key.id]);
  });

  it('restores a persisted pause after a restart, and resumes one whose end passed while the daemon was down', () => {
    const key = seedAccount(store, { kind: 'anthropic_api_key', label: 'Client key' });
    const projectId = seedProject(store, { accountId: key.id }).id;
    pauses().pause(
      key.id,
      { reason: AccountPauseReason.Refused, until: null },
      { projectId, card: card(key.id, 'r') },
    );
    const since = clock.now();
    clock.advance(30 * 60_000);
    const restarted = pauses();
    restarted.restore();
    // It remembers when it began, not when the daemon restarted.
    expect(restarted.pausedFor(key.id)).toEqual({ reason: 'refused', until: null, since });

    const short = seedAccount(store, { kind: 'anthropic_api_key', label: 'Short' });
    const work = pausedWork(seedProject(store, { accountId: short.id }));
    const before = pauses();
    before.pause(
      short.id,
      { reason: AccountPauseReason.UsageLimit, until: inMinutes(1) },
      { projectId: work.projectId, card: card(short.id, 'u') },
    );
    // The daemon stops before the pause ends, so its own timer never fires.
    before.stop();
    clock.advance(2 * 60_000);
    expect(getWorkstream(state.db, work.id).state).toBe('PAUSED_LIMIT');
    const later = pauses();
    later.restore();
    expect(later.pausedFor(short.id)).toBeNull();
    expect(getWorkstream(state.db, work.id).state).toBe('QUEUED');
    expect(resumed).toBe(1);
  });

  it('treats a pause whose end passed as over even when its timer never fired', () => {
    const work = pausedWork();
    const accountId = getProject(state.db, work.projectId).accountId;
    const p = pauses();
    p.pause(
      accountId,
      { reason: AccountPauseReason.UsageLimit, until: inMinutes(1) },
      { projectId: work.projectId, card: card(accountId, 'u') },
    );
    // A sleeping machine or a stopped timer: the clock moves, no callback runs.
    p.stop();
    clock.advance(2 * 60_000);
    expect(p.pausedFor(accountId)).toBeNull();
    expect(getWorkstream(state.db, work.id).state).toBe('QUEUED');
    expect(resumed).toBe(1);
  });

  it('keeps the held pause text when a shorter pause folds into its card', () => {
    const work = pausedWork();
    const accountId = getProject(state.db, work.projectId).accountId;
    const p = pauses();
    const at = (body: string) => ({
      projectId: work.projectId,
      card: { ...card(accountId, 'usage_limit'), body },
    });
    p.pause(
      accountId,
      { reason: AccountPauseReason.UsageLimit, until: inMinutes(120) },
      at('until 15:00'),
    );
    p.pause(
      accountId,
      { reason: AccountPauseReason.UsageLimit, until: inMinutes(30) },
      at('until 13:30'),
    );
    expect(p.pausedFor(accountId)?.until).toEqual(inMinutes(120));
    expect(listInbox(state.db, { states: ['OPEN'] }).map((i) => i.body)).toEqual(['until 15:00']);
    p.pause(
      accountId,
      { reason: AccountPauseReason.UsageLimit, until: inMinutes(180) },
      at('until 16:00'),
    );
    expect(listInbox(state.db, { states: ['OPEN'] }).map((i) => i.body)).toEqual(['until 16:00']);
  });
});
