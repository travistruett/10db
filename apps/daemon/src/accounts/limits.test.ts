import {
  ACCOUNT_CARD_DETAIL,
  AccountCardChoice,
  ConflictError,
  type AccountDto,
  type AccountId,
  type InboxAnswer,
  type InboxItemDto,
  type ProjectDto,
  type ProjectId,
} from '@10db/contracts';
import {
  createTestStore,
  findOpenByFoldKey,
  getProject,
  listInbox,
  patchAccount,
  recordAccountSecret,
  seedAccount,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import {
  accountFoldKey,
  createAccountCardAnswers,
  createAccountLimits,
  createAccountMoves,
  createAccountPauses,
  createMoveBack,
  createUsageReports,
  MOVE_BACK_CARD,
  MoveCause,
  type AccountLimits,
  type AccountMoves,
  type AccountPauses,
  type MoveBack,
  type UsageReport,
} from './index';

const DEFAULT_PAUSE_MS = 30 * 60_000;

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let inbox: InboxService;
let pauses: AccountPauses;
let moveBack: MoveBack;
let moves: AccountMoves;
let limits: AccountLimits;
let answerCard: (item: InboxItemDto, answer: InboxAnswer) => void;
let handOffs: { projectId: ProjectId; accountId: AccountId }[];
let second: AccountDto;

beforeEach(() => {
  clock = new ManualClock(new Date(2026, 9, 20, 12));
  ({ store, close } = createTestStore(() => clock.now()));
  state = createStateStore(store, createEventBus());
  inbox = createInboxService({
    state,
    onParkedAnswer: () => undefined,
    onFlagAnswer: (item, answer) => {
      answerCard(item, answer);
    },
  });
  handOffs = [];
  pauses = createAccountPauses({
    state,
    clock,
    inbox,
    stopAccount: () => Promise.resolve(),
    onResume: () => undefined,
  });
  const reports = createUsageReports({ clock, staleMs: DEFAULT_PAUSE_MS });
  moveBack = createMoveBack({
    state,
    clock,
    inbox,
    pauses,
    reports,
    defaultPauseMs: DEFAULT_PAUSE_MS,
  });
  moves = createAccountMoves({
    state,
    inbox,
    pauses,
    moveBack,
    handOff: (projectId, accountId) => {
      handOffs.push({ projectId, accountId });
    },
    onMoved: (projectId) => {
      limits.forget(projectId);
    },
  });
  limits = createAccountLimits({ state, inbox, pauses, moves, reports });
  answerCard = createAccountCardAnswers({
    resume: () => undefined,
    confirm: () => undefined,
    move: (projectId, to, why, answering) => {
      moves.move(projectId, to, why, { answering });
    },
    stay: () => undefined,
  });
  second = seedAccount(store, { kind: 'claude_subscription', label: 'Second plan' });
  // Ready to run: a usable fallback is never an account still waiting for its sign-in.
  state.write((ctx) => patchAccount(ctx, second.id, { expectedIdentity: 'second@example.com' }));
});
afterEach(() => {
  moveBack.stop();
  pauses.stop();
  close();
});

const inMinutes = (n: number) => new Date(clock.now().getTime() + n * 60_000);
const openCards = () => listInbox(state.db, { states: ['OPEN'] });
const report = (
  utilization: number | null,
  status: UsageReport['status'] = 'allowed_warning',
): UsageReport => ({ status, utilization, limitType: 'five_hour', resetsAt: inMinutes(120) });
/** A project with work in flight: only those move or are asked. */
function busy(project: ProjectDto): ProjectDto {
  seedWorkstream(store, { project });
  return project;
}

describe('usage thresholds', () => {
  it('hands off and moves a project with a fallback once its threshold is crossed', () => {
    const project = busy(seedProject(store, { fallbackAccountId: second.id }));
    const plan = project.accountId;
    limits.usageReported(plan, report(0.9));
    expect(handOffs).toEqual([]);
    limits.usageReported(plan, report(0.96));
    expect(handOffs).toEqual([{ projectId: project.id, accountId: plan }]);
    expect(getProject(state.db, project.id)).toMatchObject({
      accountId: second.id,
      movedFromAccountId: plan,
      moveBackAt: inMinutes(120).toISOString(),
    });
    const [moved] = openCards();
    expect(moved?.title).toBe(
      'demo moved to Second plan: Claude plan is at 96% of its 5-hour limit',
    );
    expect(moved?.options).toEqual([]);
    expect(moved?.detail?.[ACCOUNT_CARD_DETAIL]).toMatchObject({
      accountId: plan,
      usage: { limitType: 'five_hour', utilization: 0.96 },
    });
  });

  it('asks once per crossing when the project has no usable fallback, and moves it when the builder answers', () => {
    const project = busy(seedProject(store));
    const plan = project.accountId;
    limits.usageReported(plan, report(0.96));
    limits.usageReported(plan, report(0.97));
    const [asked] = openCards();
    if (!asked) throw new Error('no card asked');
    expect(openCards()).toHaveLength(1);
    expect(asked.title).toBe(
      'Claude plan is at 96% of its 5-hour limit: hand off and move demo to Second plan?',
    );
    expect(asked.options.map((o) => o.label)).toEqual([
      'Move to Second plan · second@example.com',
      'Later',
    ]);
    inbox.answer(asked.id, { choice: AccountCardChoice.Later });
    limits.usageReported(plan, report(0.98));
    expect(openCards()).toEqual([]);

    // The window reset (a later reset time) and usage climbed again: a new crossing.
    limits.usageReported(plan, { ...report(0.2), resetsAt: inMinutes(420) });
    limits.usageReported(plan, { ...report(0.95), resetsAt: inMinutes(420) });
    const [again] = openCards();
    if (!again) throw new Error('no card asked again');
    inbox.answer(again.id, { choice: 'Move to Second plan · second@example.com' });
    expect(handOffs).toEqual([{ projectId: project.id, accountId: plan }]);
    expect(getProject(state.db, project.id)).toMatchObject({
      accountId: second.id,
      movedFromAccountId: plan,
    });
  });

  it('forgets a crossing when the project moves, so it hands off again after moving back', () => {
    const project = busy(seedProject(store, { fallbackAccountId: second.id }));
    const plan = project.accountId;
    limits.usageReported(plan, report(0.96));
    // Back on the account while its usage is still high, with no lower report in between.
    moves.move(project.id, plan, { cause: MoveCause.Builder });
    limits.usageReported(plan, report(0.97));
    expect(handOffs).toEqual([
      { projectId: project.id, accountId: plan },
      { projectId: project.id, accountId: plan },
    ]);
    expect(getProject(state.db, project.id).accountId).toBe(second.id);
  });

  it('leaves a project with no work in flight where it is, at the threshold and at the limit', () => {
    const idle = seedProject(store, { name: 'idle', fallbackAccountId: second.id });
    limits.usageReported(idle.accountId, report(0.96));
    limits.usageReported(idle.accountId, report(null, 'rejected'));
    expect(getProject(state.db, idle.id).accountId).toBe(idle.accountId);
    expect(handOffs).toEqual([]);
    expect(openCards()).toEqual([]);
  });

  it('takes no fallback that is unready, paused or metered without a cap, and asks instead', () => {
    const key = seedAccount(store, {
      kind: 'anthropic_api_key',
      label: 'Client key',
      monthlyCapUsd: 50,
    });
    const third = seedAccount(store, { kind: 'claude_subscription', label: 'Third plan' });
    // With its secret set the key is ready, so only the missing cap keeps it from taking the project.
    state.write((ctx) => recordAccountSecret(ctx, key.id, 'fingerprint'));
    const capless = busy(seedProject(store, { name: 'capless', fallbackAccountId: key.id }));
    state.write((ctx) => patchAccount(ctx, key.id, { monthlyCapUsd: null }));
    const held = busy(seedProject(store, { name: 'held', fallbackAccountId: second.id }));
    pauses.pause(second.id, { reason: 'refused', until: null }, { projectId: held.id, card: null });
    busy(seedProject(store, { name: 'unsigned', fallbackAccountId: third.id }));
    limits.usageReported(capless.accountId, report(0.96));
    expect(handOffs).toEqual([]);
    const asked = openCards();
    expect(asked.map((c) => c.title).sort()).toEqual([
      'Claude plan is at 96% of its 5-hour limit: hand off and move capless to another account?',
      'Claude plan is at 96% of its 5-hour limit: hand off and move held to another account?',
      'Claude plan is at 96% of its 5-hour limit: hand off and move unsigned to another account?',
    ]);
    // The builder may still pick them, and each option says what it needs first.
    expect(asked[0]?.options.map((o) => o.label)).toEqual([
      'Move to Client key',
      'Move to Third plan (needs sign-in)',
      'Later',
    ]);
  });

  it('moves a project with a fallback at the hard limit without a handoff, and leaves the rest to the usage-limit card', () => {
    const leaving = busy(seedProject(store, { name: 'leaving', fallbackAccountId: second.id }));
    const staying = busy(seedProject(store, { name: 'staying' }));
    limits.usageReported(leaving.accountId, report(null, 'rejected'));
    expect(handOffs).toEqual([]);
    expect(getProject(state.db, leaving.id).accountId).toBe(second.id);
    expect(getProject(state.db, staying.id).accountId).toBe(leaving.accountId);
    expect(openCards().map((c) => c.title)).toEqual([
      'leaving moved to Second plan: Claude plan reached its 5-hour limit',
    ]);
  });

  it("uses the project's own threshold, and ignores a report with no utilization", () => {
    const early = busy(seedProject(store, { fallbackAccountId: second.id, usageHandoffAt: 0.8 }));
    limits.usageReported(early.accountId, report(null));
    expect(getProject(state.db, early.id).accountId).toBe(early.accountId);
    limits.usageReported(early.accountId, report(0.85));
    expect(getProject(state.db, early.id).accountId).toBe(second.id);
  });

  it('raises a new card for a second automatic move, not the first one left open', () => {
    const project = busy(seedProject(store, { fallbackAccountId: second.id }));
    const plan = project.accountId;
    limits.usageReported(plan, report(0.96));
    const [first] = openCards();
    moves.move(project.id, plan, { cause: MoveCause.Builder });
    limits.usageReported(plan, report(0.97));
    expect(getProject(state.db, project.id).accountId).toBe(second.id);
    const open = openCards();
    expect(open).toHaveLength(1);
    expect(open[0]?.id).not.toBe(first?.id);
  });

  it('closes a threshold card when usage falls back in a new window, so a late answer is refused', () => {
    const project = busy(seedProject(store));
    const plan = project.accountId;
    limits.usageReported(plan, report(0.96));
    const [stale] = openCards();
    if (!stale) throw new Error('no card asked');
    limits.usageReported(plan, { ...report(0.2), resetsAt: inMinutes(420) });
    expect(openCards()).toEqual([]);
    expect(() =>
      inbox.answer(stale.id, { choice: 'Move to Second plan · second@example.com' }),
    ).toThrow(ConflictError);
    expect(getProject(state.db, project.id).accountId).toBe(plan);
    limits.usageReported(plan, { ...report(0.95), resetsAt: inMinutes(420) });
    const [fresh] = openCards();
    expect(fresh?.id).not.toBe(stale.id);
  });

  it('does not ask again when a concurrent session reports a lower share in the same window', () => {
    const project = busy(seedProject(store));
    const plan = project.accountId;
    limits.usageReported(plan, report(0.96));
    const [asked] = openCards();
    if (!asked) throw new Error('no card asked');
    inbox.answer(asked.id, { choice: AccountCardChoice.Later });
    limits.usageReported(plan, report(0.94));
    limits.usageReported(plan, report(0.96));
    expect(openCards()).toEqual([]);
    expect(getProject(state.db, project.id).accountId).toBe(plan);
  });

  it('holds the move back while the account it left still reports usage past the threshold', () => {
    const project = busy(seedProject(store, { fallbackAccountId: second.id }));
    const plan = project.accountId;
    limits.usageReported(plan, { ...report(0.96), resetsAt: null });
    expect(getProject(state.db, project.id)).toMatchObject({
      accountId: second.id,
      moveBackAt: null,
    });
    const back = () =>
      findOpenByFoldKey(state.db, project.id, accountFoldKey(plan, MOVE_BACK_CARD));
    clock.advance(20 * 60_000);
    // Another session on the account still runs hot.
    limits.usageReported(plan, { ...report(0.97), resetsAt: null });
    clock.advance(10 * 60_000);
    expect(back()).toBeUndefined();
    // Nothing heard for half an hour: 10db asks, and says it doesn't know whether the limit reset.
    clock.advance(30 * 60_000);
    expect(back()?.body).toContain("10db doesn't know whether that limit has reset");
  });
});
