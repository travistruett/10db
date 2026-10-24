import {
  ACCOUNT_CARD_DETAIL,
  AccountCardChoice,
  EventType,
  type AccountDto,
  type ProjectDto,
} from '@10db/contracts';
import {
  createTestStore,
  getAccountRow,
  getWorkstream,
  listEventsAfter,
  listInbox,
  patchAccount,
  seedAccount,
  seedProject,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedSpend, seedWorkstream } from '../../test/fixtures';
import { ManualClock } from '../clock';
import type { Timer } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import {
  createAccountCardAnswers,
  createAccountPauses,
  createAccountRuntime,
  type AccountPauses,
  type AccountRuntime,
} from './index';

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let inbox: InboxService;
let pauses: AccountPauses;
let runtime: AccountRuntime;
let key: AccountDto;
let project: ProjectDto;

/** Refuses a delay Node would silently turn into 1 ms. */
class StrictClock extends ManualClock {
  override setTimeout(fn: () => void, ms: number): Timer {
    if (ms > 2 ** 31 - 1) throw new Error(`a timer of ${String(ms)} ms overflows`);
    return super.setTimeout(fn, ms);
  }
}

function build(start: Date): void {
  clock = new StrictClock(start);
  ({ store, close } = createTestStore(() => clock.now()));
  state = createStateStore(store, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  pauses = createAccountPauses({
    state,
    clock,
    inbox,
    stopAccount: () => Promise.resolve(),
    onResume: () => undefined,
  });
  runtime = createAccountRuntime({ state, clock, inbox, pauses, defaultPauseMs: 30 * 60_000 });
  key = seedAccount(store, { kind: 'anthropic_api_key', label: 'Client key', monthlyCapUsd: 5 });
  project = seedProject(store, { accountId: key.id });
}

beforeEach(() => {
  build(new Date(2026, 9, 20, 12));
});
afterEach(() => {
  close();
});

const row = () => getAccountRow(state.db, key.id);
const openCards = () => listInbox(state.db, { states: ['OPEN'] });

describe('the monthly cap', () => {
  it('lets a metered account under its cap, and never caps a subscription', () => {
    seedSpend(store, project, 4.99);
    expect(runtime.blocked(row(), project.id)).toBeNull();
    const onDefault = seedProject(store);
    seedSpend(store, onDefault, 1_000);
    expect(runtime.blocked(getAccountRow(state.db, onDefault.accountId), onDefault.id)).toBeNull();
  });

  it('pauses at the cap until the next local month, with one card and account.cap_reached', () => {
    seedSpend(store, project, 5);
    const after = listEventsAfter(state.db, 0, 1000).at(-1)?.seq ?? 0;
    const pause = runtime.blocked(row(), project.id);
    expect(pause).toEqual({ reason: 'monthly_cap', until: new Date(2026, 10, 1) });
    expect(runtime.blocked(row(), project.id)).toEqual(pause);
    expect(openCards()).toHaveLength(1);
    expect(openCards()[0]?.body).toMatch(/\$5\.00 of its \$5\.00 cap/);
    const types = listEventsAfter(state.db, after, 100).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([EventType.AccountPaused, EventType.AccountCapReached]),
    );

    const { workstream } = seedWorkstream(store, { project });
    state.write((ctx) => {
      transitionWorkstream(ctx, workstream.id, { to: 'STARTING', fence: null });
      transitionWorkstream(ctx, workstream.id, { to: 'PAUSED_LIMIT', fence: null });
    });
    clock.advance(new Date(2026, 10, 1).getTime() - clock.now().getTime());
    expect(runtime.isPaused(key.id)).toBe(false);
    expect(getWorkstream(state.db, workstream.id).state).toBe('QUEUED');
    expect(runtime.blocked(row(), project.id)).toBeNull();
  });

  it('raises the cap card in every project whose work the cap holds, once each', () => {
    const second = seedProject(store, { accountId: key.id });
    seedSpend(store, project, 5);
    runtime.blocked(row(), project.id);
    expect(runtime.blocked(row(), second.id)).toEqual({
      reason: 'monthly_cap',
      until: new Date(2026, 10, 1),
    });
    runtime.blocked(row(), second.id);
    runtime.blocked(row(), project.id);
    expect(
      openCards()
        .map((c) => c.projectId)
        .sort(),
    ).toEqual([project.id, second.id].sort());
  });

  it('holds a cap reached early in the month until the next month, with no overflowing timer', () => {
    close();
    build(new Date(2026, 9, 2, 12));
    seedSpend(store, project, 5);
    const { workstream } = seedWorkstream(store, { project });
    state.write((ctx) => {
      transitionWorkstream(ctx, workstream.id, { to: 'STARTING', fence: null });
      transitionWorkstream(ctx, workstream.id, { to: 'PAUSED_LIMIT', fence: null });
    });
    expect(runtime.blocked(row(), project.id)).toEqual({
      reason: 'monthly_cap',
      until: new Date(2026, 10, 1),
    });
    const resumes = () =>
      listEventsAfter(state.db, 0, 1000).filter((e) => e.type === EventType.AccountResumed);
    clock.advance(20 * 24 * 3_600_000);
    expect(runtime.isPaused(key.id)).toBe(true);
    expect(resumes()).toHaveLength(0);
    expect(getWorkstream(state.db, workstream.id).state).toBe('PAUSED_LIMIT');
    // The first capped timer fires on Oct 27; the pause must be re-armed, not resumed, then.
    for (const day of [28, 31]) {
      clock.advance(new Date(2026, 9, day, 12).getTime() - clock.now().getTime());
      expect(runtime.isPaused(key.id)).toBe(true);
      expect(resumes()).toHaveLength(0);
    }
    clock.advance(new Date(2026, 10, 1).getTime() - clock.now().getTime());
    expect(runtime.isPaused(key.id)).toBe(false);
    expect(resumes()).toHaveLength(1);
    expect(getWorkstream(state.db, workstream.id).state).toBe('QUEUED');
  });

  it("rewrites every project's cap card as sessions end, since spend is account-wide", () => {
    const second = seedProject(store, { accountId: key.id });
    seedSpend(store, project, 5);
    runtime.blocked(row(), project.id);
    runtime.blocked(row(), second.id);
    seedSpend(store, second, 1);
    runtime.sessionEnded(row(), second.id);
    seedSpend(store, second, 1);
    runtime.sessionEnded(row(), second.id);
    const bodies = openCards().map((c) => c.body);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).toMatch(/\$7\.00 of its \$5\.00 cap.*\$2\.00 over/);
  });

  it("shows the new month's spend when the cap is reached again after the month turned", () => {
    seedSpend(store, project, 5);
    runtime.blocked(row(), project.id);
    clock.advance(new Date(2026, 10, 1).getTime() - clock.now().getTime());
    expect(runtime.isPaused(key.id)).toBe(false);
    seedSpend(store, project, 6);
    runtime.blocked(row(), project.id);
    const cards = openCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.body).toMatch(/\$6\.00 of its \$5\.00 cap is spent in 2026-11/);
  });

  it('rewrites the cap card with the overshoot as running sessions end', () => {
    seedSpend(store, project, 5);
    runtime.blocked(row(), project.id);
    seedSpend(store, project, 2);
    runtime.sessionEnded(row(), project.id);
    expect(openCards()).toHaveLength(1);
    expect(openCards()[0]?.body).toMatch(/\$7\.00 of its \$5\.00 cap.*\$2\.00 over/);
  });

  it('resumes when the cap is raised', () => {
    seedSpend(store, project, 5);
    runtime.blocked(row(), project.id);
    state.write((ctx) => patchAccount(ctx, key.id, { monthlyCapUsd: 10 }));
    runtime.saved(key.id);
    expect(runtime.isPaused(key.id)).toBe(false);
    expect(runtime.blocked(row(), project.id)).toBeNull();
  });
});

describe('refusals and usage limits', () => {
  it('pauses a refused account with no end, outranking a usage limit, until it is saved', () => {
    runtime.refused(row(), project.id, {
      problem: 'secret_changed',
      message: 'The Keychain secret of account "Client key" changed outside 10db',
      seenIdentity: null,
    });
    runtime.rateLimited(key.id, new Date(clock.now().getTime() + 60_000), project.id);
    expect(runtime.blocked(row(), project.id)).toEqual({ reason: 'refused', until: null });
    const refusal = openCards().find((c) => c.title.includes('refused'));
    expect(refusal?.body).toContain('PUT /accounts/');
    expect(refusal?.options.map((o) => o.label)).toEqual(['Resume', 'Later']);
    runtime.saved(key.id);
    expect(runtime.isPaused(key.id)).toBe(false);
  });

  it('leaves a usage-limit pause alone when the account is saved', () => {
    runtime.rateLimited(key.id, null, project.id);
    runtime.saved(key.id);
    expect(runtime.blocked(row(), project.id)?.reason).toBe('usage_limit');
    clock.advance(30 * 60_000);
    expect(runtime.isPaused(key.id)).toBe(false);
  });

  it('offers Confirm on a refusal that names a subscription email', () => {
    const onDefault = seedProject(store);
    runtime.refused(getAccountRow(state.db, onDefault.accountId), onDefault.id, {
      problem: 'identity_mismatch',
      message:
        'Claude Code reported a different email than the one confirmed for account "Claude plan"',
      seenIdentity: 'other@example.com',
    });
    expect(openCards()[0]?.options.map((o) => o.label)).toEqual(['Confirm', 'Resume', 'Later']);
  });

  it('resumes a refused account when its card is answered Resume', () => {
    runtime.refused(row(), project.id, {
      problem: 'cannot_bill',
      message: 'x',
      seenIdentity: null,
    });
    const answers = createAccountCardAnswers({
      resume: (id) => {
        pauses.resume(id);
      },
      confirm: () => undefined,
    });
    const item = openCards()[0];
    if (!item) throw new Error('the refusal raised no card');
    expect(item.detail?.[ACCOUNT_CARD_DETAIL]).toMatchObject({
      accountId: key.id,
      reason: 'refused',
      problem: 'cannot_bill',
    });
    answers(item, { choice: AccountCardChoice.Resume });
    expect(runtime.isPaused(key.id)).toBe(false);
  });
});
