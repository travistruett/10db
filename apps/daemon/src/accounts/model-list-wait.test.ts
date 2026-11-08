import { createTestStore, listInbox, seedAccount, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capturingLogger } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import { createModelListWait, MODEL_LIST_WAIT_MS, type ModelListWait } from './model-list-wait';

let store: Store;
let close: () => void;
let clock: ManualClock;
let inbox: InboxService;
let logger: ReturnType<typeof capturingLogger>;
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
  wait = startWait();
});

/** A wait as a daemon starts one, over the store: a second one is the same daemon after a restart. */
function startWait(): ModelListWait {
  return createModelListWait({
    db: store.db,
    clock,
    inbox,
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
    wait.hold(account, project.id);
    expect(wait.holds(account.id)).toBe(true);
    clock.advance(MODEL_LIST_WAIT_MS - 1);
    expect(wait.holds(account.id)).toBe(true);
    clock.advance(1);
    expect(wait.holds(account.id)).toBe(false);
  });

  it('holds only the account that is waiting', () => {
    const project = seedProject(store);
    const other = seedAccount(store, { kind: 'claude_subscription', label: 'Other' });
    wait.hold({ id: project.accountId, label: 'Codex plan' }, project.id);
    expect(wait.holds(other.id)).toBe(false);
  });

  it('logs once per account however often it is held again', () => {
    const project = seedProject(store);
    const account = { id: project.accountId, label: 'Codex plan' };
    wait.hold(account, project.id);
    clock.advance(MODEL_LIST_WAIT_MS);
    wait.hold(account, project.id);
    wait.hold(account, project.id);
    expect(logger.lines().filter((l) => l.includes('model list'))).toHaveLength(1);
  });

  it('opens one card naming the account, however often it is held again', () => {
    const project = seedProject(store);
    const account = { id: project.accountId, label: 'Codex plan' };
    wait.hold(account, project.id);
    wait.hold(account, project.id);
    const cards = openCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe('Codex plan is waiting for its model list');
  });

  it('keeps the card and the hold when a rebuild finds the account still without profiles, but lets a lane try', () => {
    const project = seedProject(store);
    wait.hold({ id: project.accountId, label: 'Codex plan' }, project.id);
    wait.release(() => false);
    expect(wait.holds(project.accountId)).toBe(false);
    expect(openCards()).toHaveLength(1);
    expect(released).toBe(1);
  });

  it('closes the card and asks for a tick when the account’s profiles appear', () => {
    const project = seedProject(store);
    wait.hold({ id: project.accountId, label: 'Codex plan' }, project.id);
    wait.release(() => true);
    expect(wait.holds(project.accountId)).toBe(false);
    expect(openCards()).toEqual([]);
    expect(released).toBe(1);
  });

  it('closes a card an earlier daemon left, once the account’s profiles are built', () => {
    const project = seedProject(store);
    wait.hold({ id: project.accountId, label: 'Codex plan' }, project.id);
    expect(openCards()).toHaveLength(1);
    const restarted = startWait();
    restarted.release(() => true);
    expect(openCards()).toEqual([]);
  });

  it('keeps a card an earlier daemon left while the account still has no profiles', () => {
    const project = seedProject(store);
    wait.hold({ id: project.accountId, label: 'Codex plan' }, project.id);
    const restarted = startWait();
    restarted.release(() => false);
    expect(openCards()).toHaveLength(1);
    expect(restarted.holds(project.accountId)).toBe(false);
  });

  it('does nothing when no account is waiting', () => {
    wait.release(() => true);
    expect(released).toBe(0);
  });
});
