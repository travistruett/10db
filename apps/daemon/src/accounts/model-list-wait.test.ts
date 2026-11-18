import { createTestStore, listInbox, seedAccount, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capturingLogger } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import { createStatusService, STATUS_HYSTERESIS_MS, type StatusService } from '../status';
import { createModelListWait, MODEL_LIST_WAIT_MS, type ModelListWait } from './model-list-wait';

let store: Store;
let close: () => void;
let clock: ManualClock;
let inbox: InboxService;
let logger: ReturnType<typeof capturingLogger>;
let status: StatusService;
let released: number;
let wait: ModelListWait;

beforeEach(() => {
  clock = new ManualClock(new Date(2026, 9, 20, 12));
  ({ store, close } = createTestStore(() => clock.now()));
  inbox = createInboxService({
    state: createStateStore(store, createEventBus()),
    onParkedAnswer: () => undefined,
  });
  logger = capturingLogger();
  released = 0;
  status = createStatusService({ clock, onChange: () => undefined });
  wait = startWait();
});

/** A wait as a daemon starts one, over the store: a second one is the same daemon after a restart. */
function startWait(): ModelListWait {
  return createModelListWait({
    db: store.db,
    clock,
    inbox,
    status,
    logger,
    onReleased: () => {
      released += 1;
    },
  });
}
afterEach(() => {
  close();
});

const openCards = () => listInbox(store.db, { states: ['OPEN'] });

describe('a lane waiting for its account’s model list', () => {
  it('holds the account for five minutes, then lets a lane try again', () => {
    const project = seedProject(store);
    const account = { id: project.accountId, label: 'Codex plan' };
    expect(wait.holds(account.id)).toBe(false);
    wait.hold(account);
    expect(wait.holds(account.id)).toBe(true);
    clock.advance(MODEL_LIST_WAIT_MS - 1);
    expect(wait.holds(account.id)).toBe(true);
    clock.advance(1);
    expect(wait.holds(account.id)).toBe(false);
  });

  it('holds only the account that is waiting', () => {
    const project = seedProject(store);
    const other = seedAccount(store, { kind: 'claude_subscription', label: 'Other' });
    wait.hold({ id: project.accountId, label: 'Codex plan' });
    expect(wait.holds(other.id)).toBe(false);
  });

  it('logs once per account however often it is held again', () => {
    const project = seedProject(store);
    const account = { id: project.accountId, label: 'Codex plan' };
    wait.hold(account);
    clock.advance(MODEL_LIST_WAIT_MS);
    wait.hold(account);
    wait.hold(account);
    expect(logger.lines().filter((l) => l.includes('model list'))).toHaveLength(1);
  });

  it('shows one line naming the account once the wait has lasted 2 minutes, and raises no card', () => {
    const project = seedProject(store);
    const account = { id: project.accountId, label: 'Codex plan' };
    wait.hold(account);
    wait.hold(account);
    clock.advance(STATUS_HYSTERESIS_MS);
    expect(status.current().lines.map((l) => l.line)).toEqual([
      'Codex plan is waiting for its model list',
    ]);
    expect(openCards()).toEqual([]);
  });

  it('lets a lane try again on a rebuild, and asks for a tick', () => {
    const project = seedProject(store);
    wait.hold({ id: project.accountId, label: 'Codex plan' });
    wait.release(() => false);
    expect(wait.holds(project.accountId)).toBe(false);
    expect(released).toBe(1);
  });

  it('withdraws a card an earlier version left open when it is made', () => {
    const project = seedProject(store);
    inbox.flag({
      projectId: project.id,
      workstreamId: null,
      tier: 'status',
      urgency: 'low',
      closesWhen: { by: 'withdrawn', when: 'old' },
      title: 'Codex plan is waiting for its model list',
      body: 'stale',
      foldKey: `model-list-wait:${project.accountId}`,
    });
    expect(openCards()).toHaveLength(1);
    startWait();
    expect(openCards()).toEqual([]);
  });

  it('logs the first hold after a restart once', () => {
    const project = seedProject(store);
    const account = { id: project.accountId, label: 'Codex plan' };
    wait.hold(account);
    const restarted = startWait();
    const before = logger.lines().filter((l) => l.includes('model list')).length;
    restarted.hold(account);
    restarted.hold(account);
    expect(logger.lines().filter((l) => l.includes('model list')).length - before).toBe(1);
  });

  it('does nothing when no account is waiting', () => {
    wait.release(() => true);
    expect(released).toBe(0);
  });
});
