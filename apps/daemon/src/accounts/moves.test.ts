import {
  AccountCardChoice,
  AccountPauseReason,
  ConflictError,
  InvalidError,
  type AccountDto,
  type AccountId,
  type InboxAnswer,
  type InboxItemDto,
  type ProjectDto,
  type ProjectId,
} from '@10db/contracts';
import {
  archiveAccount,
  createTestStore,
  findOpenByFoldKey,
  getAccount,
  getAccountRow,
  getProject,
  listEventsAfter,
  listInbox,
  seedAccount,
  seedProject,
  setMoveBack,
  patchProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { ManualClock, type Timer } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import {
  accountFoldKey,
  createAccountCardAnswers,
  createAccountMoves,
  createAccountPauses,
  createAccountRuntime,
  createMoveBack,
  createUsageReports,
  MOVE_BACK_CARD,
  MoveCause,
  type AccountMoves,
  type AccountPauses,
  type AccountRuntime,
  type MoveBack,
} from './index';
import { moveTargets } from './moves';
import { movedCard, recordedCard, refusedCard, usageHighCard } from './cards';
import type { PauseRequest } from './pauses';

const DEFAULT_PAUSE_MS = 30 * 60_000;

let store: Store;
let close: () => void;
let state: StateStore;
/** A clock whose timers can be made to fire late, as after the machine slept past them. */
class SleepyClock extends ManualClock {
  asleep = false;
  override setTimeout(fn: () => void, ms: number): Timer {
    return this.asleep ? { cancel: () => undefined } : super.setTimeout(fn, ms);
  }
}

let clock: SleepyClock;
let inbox: InboxService;
let pauses: AccountPauses;
let runtime: AccountRuntime;
let moveBack: MoveBack;
let moves: AccountMoves;
let answerCard: (item: InboxItemDto, answer: InboxAnswer) => void;
let ticks: number;
let handOffs: { projectId: ProjectId; accountId: AccountId }[];
let project: ProjectDto;
let plan: AccountId;
let second: AccountDto;

/** The daemon's account runtime over the store; a restart builds it again. */
function build(): void {
  pauses = createAccountPauses({
    state,
    clock,
    inbox,
    stopAccount: () => Promise.resolve(),
    onResume: () => undefined,
  });
  runtime = createAccountRuntime({ state, clock, inbox, pauses, defaultPauseMs: DEFAULT_PAUSE_MS });
  moveBack = createMoveBack({
    state,
    clock,
    inbox,
    pauses,
    reports: createUsageReports({ clock, staleMs: DEFAULT_PAUSE_MS }),
    defaultPauseMs: DEFAULT_PAUSE_MS,
    back: (projectId, to) => {
      moves.move(projectId, to, { cause: MoveCause.MoveBack });
    },
  });
  moves = createAccountMoves({
    state,
    inbox,
    pauses,
    moveBack,
    handOff: (projectId, accountId) => {
      handOffs.push({ projectId, accountId });
    },
    onMoved: () => {
      ticks += 1;
    },
  });
  answerCard = createAccountCardAnswers({
    resume: (id, about) => {
      pauses.resume(id, about);
    },
    confirm: () => undefined,
    move: (projectId, to, why, answering) => {
      moves.move(projectId, to, why, { answering });
    },
    stay: (projectId) => {
      moves.stay(projectId);
    },
    recheck: () => undefined,
    raiseCap: () => undefined,
  });
}

beforeEach(() => {
  clock = new SleepyClock(new Date(2026, 9, 20, 12));
  ({ store, close } = createTestStore(() => clock.now()));
  state = createStateStore(store, createEventBus());
  // As in the daemon: a card's answer acts before the inbox records it.
  inbox = createInboxService({
    state,
    onParkedAnswer: () => undefined,
    onFlagAnswer: (item, answer) => {
      answerCard(item, answer);
    },
  });
  ticks = 0;
  handOffs = [];
  build();
  project = seedProject(store);
  plan = project.accountId;
  // Work in flight, so a usage limit on the project's account raises its card.
  seedWorkstream(store, { project });
  second = seedAccount(store, { kind: 'claude_subscription', label: 'Second plan' });
});
afterEach(() => {
  moveBack.stop();
  pauses.stop();
  close();
});

const inMinutes = (n: number) => new Date(clock.now().getTime() + n * 60_000);
const openCards = () => listInbox(state.db, { states: ['OPEN'] });
/** The project's open card about the default account, found by what it is about. */
function cardAbout(about: string, projectId: ProjectId = project.id): InboxItemDto {
  const found = findOpenByFoldKey(state.db, projectId, accountFoldKey(plan, about));
  if (!found) throw new Error(`no open ${about} card`);
  return found;
}
const limitCard = () => cardAbout(AccountPauseReason.UsageLimit);
const backCard = () => cardAbout(MOVE_BACK_CARD);
/** The second plan has no confirmed identity yet, so the option says what it needs. */
const CONTINUE = 'Continue on Second plan (needs sign-in)';

describe('where a project can move', () => {
  it('never offers an OpenRouter account, which runs no agent', () => {
    const project = seedProject(store);
    const second = seedAccount(store, { kind: 'anthropic_api_key', label: 'Spare key' });
    seedAccount(store, { kind: 'openrouter', label: 'OpenRouter' });
    const targets = moveTargets(store.db, project, () => false);
    expect(targets.map((a) => a.id)).toContain(second.id);
    expect(targets.map((a) => a.kind)).not.toContain('openrouter');
  });
});

describe('moving a project', () => {
  it('offers to continue on each account the project could move to, and moves it when one is chosen', () => {
    const paused = seedAccount(store, { kind: 'claude_subscription', label: 'Paused plan' });
    pauses.pause(
      paused.id,
      { reason: 'refused', until: null },
      { projectId: project.id, card: null },
    );
    runtime.rateLimited(plan, inMinutes(60), project.id);
    const limit = limitCard();
    expect(limit.title).toBe('Claude plan usage limit reached');
    expect(limit.options.map((o) => o.label)).toEqual([CONTINUE, 'Later']);

    inbox.answer(limit.id, { choice: CONTINUE });
    expect(getProject(state.db, project.id)).toMatchObject({
      accountId: second.id,
      movedFromAccountId: plan,
      moveBackAt: inMinutes(60).toISOString(),
    });
    expect(ticks).toBe(1);
  });

  it.each([
    ['a Claude project from another Claude account', 'claude', 'claude'],
    ['a ChatGPT project from a Claude account', 'chatgpt', 'claude'],
    ['a Claude project from a ChatGPT account', 'claude', 'chatgpt'],
  ] as const)(
    'asks once the limit resets whether to move %s back, and moves back on Move back',
    (_name, fromPlan, toPlan) => {
      const chatgpt = seedAccount(store, { kind: 'codex_signin', label: 'ChatGPT plan' });
      if (fromPlan === 'chatgpt') {
        project = seedProject(store, { name: 'gpt', accountId: chatgpt.id });
        plan = chatgpt.id;
        seedWorkstream(store, { project });
      }
      const to = toPlan === 'chatgpt' ? chatgpt : second;
      runtime.rateLimited(plan, inMinutes(60), project.id);
      // A move by PATCH while the account is paused for its usage limit is remembered too.
      moves.move(project.id, to.id, { cause: MoveCause.Builder });
      expect(getProject(state.db, project.id).movedFromAccountId).toBe(plan);
      // The usage-limit card offered a move the builder has made another way.
      expect(openCards()).toEqual([]);

      clock.advance(60 * 60_000);
      const back = backCard();
      expect(back.title).toBe(
        `${getAccount(state.db, plan).label} is available again: move ${project.name} back?`,
      );
      expect(back.body).toContain('that limit has reset');
      expect(back.options.map((o) => o.label)).toEqual(['Move back', 'Stay']);
      inbox.answer(back.id, { choice: AccountCardChoice.MoveBack });
      expect(getProject(state.db, project.id)).toMatchObject({
        accountId: plan,
        movedFromAccountId: null,
        moveBackAt: null,
      });
    },
  );

  it('stays where it is on Stay, and forgets the move back', () => {
    runtime.rateLimited(plan, inMinutes(60), project.id);
    moves.move(project.id, second.id, { cause: MoveCause.Builder });
    clock.advance(60 * 60_000);
    inbox.answer(backCard().id, { choice: AccountCardChoice.Stay });
    expect(getProject(state.db, project.id)).toMatchObject({
      accountId: second.id,
      movedFromAccountId: null,
      moveBackAt: null,
    });
  });

  it('waits while the account the builder left is still paused, and asks when that pause ends', () => {
    const stayer = seedProject(store, { name: 'stayer' });
    runtime.rateLimited(plan, inMinutes(60), project.id);
    moves.move(project.id, second.id, { cause: MoveCause.Builder });
    // A session of a project still on the account meets the limit again, later.
    runtime.rateLimited(plan, inMinutes(120), stayer.id);
    clock.advance(60 * 60_000);
    expect(
      findOpenByFoldKey(state.db, project.id, accountFoldKey(plan, MOVE_BACK_CARD)),
    ).toBeUndefined();
    clock.advance(60 * 60_000);
    expect(backCard().projectId).toBe(project.id);
  });

  it('asks, and says so, when a move back is due and nobody reported when the limit resets', () => {
    // A move recorded before the move back was automatic, with no reset time.
    state.write((ctx) => {
      patchProject(ctx, project.id, { accountId: second.id });
      setMoveBack(ctx, project.id, { accountId: plan, at: null });
    });
    moveBack.arm(project.id);
    clock.advance(DEFAULT_PAUSE_MS - 1);
    expect(
      findOpenByFoldKey(state.db, project.id, accountFoldKey(plan, MOVE_BACK_CARD)),
    ).toBeUndefined();
    clock.advance(1);
    expect(backCard().body).toContain("10db doesn't know whether that limit has reset");
    expect(getProject(state.db, project.id).accountId).toBe(second.id);
  });

  it('raises the card of a hand move whose move back came due while the daemon was down', () => {
    runtime.rateLimited(plan, inMinutes(60), project.id);
    moves.move(project.id, second.id, { cause: MoveCause.Builder });
    moveBack.stop();
    pauses.stop();
    clock.advance(90 * 60_000);
    build();
    pauses.restore();
    moveBack.restore();
    expect(backCard().projectId).toBe(project.id);
  });

  it('remembers nothing for a plain move, and moves nothing when another field of the change is refused', () => {
    moves.move(
      project.id,
      second.id,
      { cause: MoveCause.Builder },
      { patch: { accountId: second.id, maxLanes: 3 } },
    );
    expect(getProject(state.db, project.id)).toMatchObject({
      accountId: second.id,
      maxLanes: 3,
      movedFromAccountId: null,
    });
    expect(() =>
      moves.move(
        project.id,
        plan,
        { cause: MoveCause.Builder },
        { patch: { accountId: plan, nudgePct: 10 } },
      ),
    ).toThrow(InvalidError);
    expect(getProject(state.db, project.id).accountId).toBe(second.id);
  });

  it('nudges no lane when the move is refused', () => {
    const old = seedAccount(store, { kind: 'claude_subscription', label: 'Old plan' });
    state.write((ctx) => archiveAccount(ctx, old.id));
    expect(() =>
      moves.move(project.id, old.id, {
        cause: MoveCause.UsageLimit,
        resetsAt: null,
        handOff: true,
      }),
    ).toThrow(InvalidError);
    expect(handOffs).toEqual([]);
    expect(getProject(state.db, project.id).accountId).toBe(plan);
  });

  it('moves a project when its threshold card is answered, though no usage limit is in force', () => {
    const report = {
      status: 'allowed_warning',
      utilization: 0.96,
      limitType: 'five_hour',
      resetsAt: inMinutes(60),
    } as const;
    const asked = inbox.flag({
      projectId: project.id,
      workstreamId: null,
      ...usageHighCard(
        project,
        getAccountRow(state.db, plan),
        [getAccount(state.db, second.id)],
        report,
      ),
    });
    expect(pauses.pausedFor(plan)).toBeNull();
    inbox.answer(asked.id, { choice: 'Move to Second plan (needs sign-in)' });
    expect(getProject(state.db, project.id)).toMatchObject({
      accountId: second.id,
      movedFromAccountId: plan,
      moveBackAt: inMinutes(60).toISOString(),
    });
    expect(handOffs).toEqual([{ projectId: project.id, accountId: plan }]);
  });

  it('withdraws an open move-back card when the project moves again', () => {
    const third = seedAccount(store, { kind: 'claude_subscription', label: 'Third plan' });
    runtime.rateLimited(plan, inMinutes(60), project.id);
    moves.move(project.id, second.id, { cause: MoveCause.Builder });
    clock.advance(60 * 60_000);
    const back = backCard();
    moves.move(project.id, third.id, { cause: MoveCause.Builder });
    expect(openCards().map((c) => c.id)).not.toContain(back.id);
  });

  it('keeps a limit card current as the accounts it could move to change', () => {
    const paused = seedAccount(store, { kind: 'claude_subscription', label: 'Paused plan' });
    pauses.pause(
      paused.id,
      { reason: 'refused', until: null },
      { projectId: project.id, card: null },
    );
    runtime.rateLimited(plan, inMinutes(60), project.id);
    // Only the paused account and the second plan exist besides this one: the second is offered.
    expect(limitCard().options.map((o) => o.label)).toEqual([CONTINUE, 'Later']);
    // The second plan is then refused: the card no longer offers a move there.
    pauses.pause(
      second.id,
      { reason: 'refused', until: null },
      { projectId: project.id, card: null },
    );
    runtime.rateLimited(plan, inMinutes(90), project.id);
    expect(limitCard().options.map((o) => o.label)).toEqual(['Later']);
    expect(limitCard().detail?.['accountCard']).toMatchObject({ moves: [] });
    // And when the second plan is free again, the card offers it once more.
    pauses.resume(second.id);
    runtime.rateLimited(plan, inMinutes(120), project.id);
    expect(limitCard().options.map((o) => o.label)).toEqual([CONTINUE, 'Later']);
    inbox.answer(limitCard().id, { choice: CONTINUE });
    expect(getProject(state.db, project.id).accountId).toBe(second.id);
  });

  it.each<[string, PauseRequest, string]>([
    [
      'its monthly cap',
      { reason: 'monthly_cap', until: new Date(2026, 10, 1) },
      `paused until ${new Date(2026, 10, 1).toISOString()}`,
    ],
    ['a refusal', { reason: 'refused', until: null }, 'paused until the account is fixed'],
  ])(
    'moves a project off an account held by %s when it hits its usage limit',
    (_name, held, shown) => {
      pauses.pause(plan, held, { projectId: project.id, card: null });
      runtime.rateLimited(plan, inMinutes(60), project.id);
      // The card shows the pause in force, which outlasts the usage limit.
      const limit = limitCard();
      expect(limit.body).toContain(shown);
      expect(limit.body).not.toContain(inMinutes(60).toISOString());

      inbox.answer(limit.id, { choice: CONTINUE });
      expect(getProject(state.db, project.id)).toMatchObject({
        accountId: second.id,
        movedFromAccountId: plan,
      });
      expect(openCards().map((c) => c.id)).not.toContain(limit.id);
    },
  );

  it.each<[string, PauseRequest, () => void]>([
    [
      'its monthly cap',
      { reason: 'monthly_cap', until: new Date(2026, 10, 1) },
      () => {
        clock.advance(new Date(2026, 10, 1).getTime() - clock.now().getTime());
      },
    ],
    [
      'a refusal',
      { reason: 'refused', until: null },
      () => {
        pauses.resume(plan);
        clock.advance(DEFAULT_PAUSE_MS);
      },
    ],
  ])('moves back only once the pause holding an account held by %s lifts', (_name, held, lift) => {
    pauses.pause(plan, held, { projectId: project.id, card: null });
    runtime.rateLimited(plan, inMinutes(60), project.id);
    inbox.answer(limitCard().id, { choice: CONTINUE });
    // Past the usage limit's reset and the default pause, the account the project left is still held.
    clock.advance(60 * 60_000);
    clock.advance(DEFAULT_PAUSE_MS);
    expect(getProject(state.db, project.id).accountId).toBe(second.id);

    lift();
    expect(getProject(state.db, project.id).accountId).toBe(plan);
    expect(openCards()).toEqual([]);
  });

  it('closes a limit card when its pause ends, so a later answer moves nothing', () => {
    runtime.rateLimited(plan, inMinutes(60), project.id);
    const stale = limitCard();
    clock.advance(60 * 60_000);
    expect(openCards()).toEqual([]);
    expect(() => inbox.answer(stale.id, { choice: CONTINUE })).toThrow(ConflictError);
    expect(getProject(state.db, project.id).accountId).toBe(plan);
    // The next pause raises a card of its own, showing its own end.
    runtime.rateLimited(plan, inMinutes(30), project.id);
    expect(limitCard().id).not.toBe(stale.id);
    expect(limitCard().body).toContain(inMinutes(30).toISOString());
  });

  it('refuses Stay on a card that does not offer it, and keeps the move back', () => {
    runtime.rateLimited(plan, inMinutes(60), project.id);
    inbox.answer(limitCard().id, { choice: CONTINUE });
    const recorded = inbox.flag({
      projectId: project.id,
      workstreamId: null,
      ...recordedCard(getAccountRow(state.db, second.id), 'someone@example.com'),
    });
    expect(() => inbox.answer(recorded.id, { choice: AccountCardChoice.Stay })).toThrow(
      InvalidError,
    );
    expect(getProject(state.db, project.id).movedFromAccountId).toBe(plan);
  });

  it('refuses an answer that races the end of the limit: nothing moves, and the card is gone', () => {
    // The machine sleeps past the reset, so the pause's own timer never gets to fire.
    clock.asleep = true;
    runtime.rateLimited(plan, inMinutes(60), project.id);
    const card = limitCard();
    clock.advance(61 * 60_000);
    expect(() => inbox.answer(card.id, { choice: CONTINUE })).toThrow(ConflictError);
    expect(getProject(state.db, project.id)).toMatchObject({
      accountId: plan,
      movedFromAccountId: null,
    });
    expect(openCards()).toEqual([]);
  });

  it('closes a limit card whose pause ended while the daemon was down', () => {
    runtime.rateLimited(plan, inMinutes(60), project.id);
    const stale = limitCard();
    moveBack.stop();
    pauses.stop();
    clock.advance(90 * 60_000);
    build();
    pauses.restore();
    expect(openCards().map((c) => c.id)).not.toContain(stale.id);
  });

  it('closes a limit card when the refusal that replaced its pause is lifted', () => {
    runtime.rateLimited(plan, inMinutes(60), project.id);
    const stale = limitCard();
    pauses.pause(plan, { reason: 'refused', until: null }, { projectId: project.id, card: null });
    pauses.resume(plan);
    expect(openCards().map((c) => c.id)).not.toContain(stale.id);
  });

  it('refuses a choice that the card no longer offers', () => {
    runtime.rateLimited(plan, inMinutes(60), project.id);
    const card = limitCard();
    pauses.pause(
      second.id,
      { reason: 'refused', until: null },
      { projectId: project.id, card: null },
    );
    runtime.rateLimited(plan, inMinutes(90), project.id);
    expect(() => inbox.answer(card.id, { choice: CONTINUE })).toThrow(InvalidError);
    expect(getProject(state.db, project.id).accountId).toBe(plan);
  });
});

describe('moving back by itself', () => {
  /** The `project.changed` events that name a move back, with the accounts they name. */
  const movedBackEvents = () =>
    listEventsAfter(state.db, 0, 10_000).filter(
      (e) => e.entityId === project.id && e.data['movedBack'] !== undefined,
    );

  it('returns a project that left for its usage limit once the limit resets, with no card and no hand-off', () => {
    moves.move(project.id, second.id, {
      cause: MoveCause.UsageLimit,
      resetsAt: inMinutes(60),
      handOff: false,
    });
    const movedTicks = ticks;
    clock.advance(60 * 60_000 - 1);
    expect(getProject(state.db, project.id).accountId).toBe(second.id);
    clock.advance(1);
    expect(getProject(state.db, project.id)).toMatchObject({
      accountId: plan,
      movedFromAccountId: null,
      moveBackAt: null,
    });
    expect(openCards()).toEqual([]);
    expect(handOffs).toEqual([]);
    // The scheduler looks again, so a lane's next session runs on the plan.
    expect(ticks).toBe(movedTicks + 1);
    expect(movedBackEvents().map((e) => e.data['movedBack'])).toEqual([
      { fromAccountId: second.id, toAccountId: plan },
    ]);
  });

  it('returns a project whose limit card the builder answered, which is still a move for the limit', () => {
    runtime.rateLimited(plan, inMinutes(60), project.id);
    inbox.answer(limitCard().id, { choice: CONTINUE });
    clock.advance(60 * 60_000);
    expect(getProject(state.db, project.id).accountId).toBe(plan);
    expect(openCards()).toEqual([]);
  });

  it('returns a project that waited the default pause when nobody reported when the limit resets', () => {
    moves.move(project.id, second.id, {
      cause: MoveCause.UsageLimit,
      resetsAt: null,
      handOff: false,
    });
    clock.advance(DEFAULT_PAUSE_MS - 1);
    expect(getProject(state.db, project.id).accountId).toBe(second.id);
    clock.advance(1);
    expect(getProject(state.db, project.id).accountId).toBe(plan);
    expect(openCards()).toEqual([]);
  });

  it('leaves a project the builder moved by hand where it is, and still asks about it', () => {
    runtime.rateLimited(plan, inMinutes(60), project.id);
    moves.move(project.id, second.id, { cause: MoveCause.Builder });
    clock.advance(24 * 60 * 60_000);
    expect(getProject(state.db, project.id).accountId).toBe(second.id);
    expect(movedBackEvents()).toEqual([]);
    expect(backCard().projectId).toBe(project.id);
  });

  it('leaves a project the builder moved by hand where it is when the account was not at a limit', () => {
    moves.move(project.id, second.id, { cause: MoveCause.Builder });
    clock.advance(24 * 60 * 60_000);
    expect(getProject(state.db, project.id).accountId).toBe(second.id);
    expect(openCards()).toEqual([]);
  });

  it('keeps a hand move after an automatic one: the later move decides', () => {
    const third = seedAccount(store, { kind: 'claude_subscription', label: 'Third plan' });
    moves.move(project.id, second.id, {
      cause: MoveCause.UsageLimit,
      resetsAt: inMinutes(60),
      handOff: false,
    });
    moves.move(project.id, third.id, { cause: MoveCause.Builder });
    clock.advance(24 * 60 * 60_000);
    expect(getProject(state.db, project.id).accountId).toBe(third.id);
    expect(movedBackEvents()).toEqual([]);
  });

  it('stays on the fallback while the account it left is paused, and goes back when that pause ends', () => {
    const stayer = seedProject(store, { name: 'stayer' });
    runtime.rateLimited(plan, inMinutes(60), project.id);
    inbox.answer(limitCard().id, { choice: CONTINUE });
    // A session of a project still on the account meets the limit again, later.
    runtime.rateLimited(plan, inMinutes(120), stayer.id);
    clock.advance(60 * 60_000);
    expect(getProject(state.db, project.id).accountId).toBe(second.id);
    clock.advance(60 * 60_000);
    expect(getProject(state.db, project.id).accountId).toBe(plan);
  });

  it('stays on the fallback while the account it left is archived, and forgets the move back', () => {
    const old = seedAccount(store, { kind: 'claude_subscription', label: 'Old plan' });
    moves.move(project.id, old.id, { cause: MoveCause.Builder });
    moves.move(project.id, second.id, {
      cause: MoveCause.UsageLimit,
      resetsAt: inMinutes(60),
      handOff: false,
    });
    state.write((ctx) => archiveAccount(ctx, old.id));
    clock.advance(60 * 60_000);
    expect(getProject(state.db, project.id)).toMatchObject({
      accountId: second.id,
      movedFromAccountId: null,
    });
    expect(movedBackEvents()).toEqual([]);
  });

  it('goes back after the next start when the move back came due while the daemon was stopped', () => {
    moves.move(project.id, second.id, {
      cause: MoveCause.UsageLimit,
      resetsAt: inMinutes(60),
      handOff: false,
    });
    moveBack.stop();
    pauses.stop();
    clock.advance(90 * 60_000);
    expect(getProject(state.db, project.id).accountId).toBe(second.id);
    build();
    pauses.restore();
    moveBack.restore();
    expect(getProject(state.db, project.id).accountId).toBe(plan);
    expect(openCards()).toEqual([]);
  });

  it('does not go back once the builder chose Stay', () => {
    moves.move(project.id, second.id, {
      cause: MoveCause.UsageLimit,
      resetsAt: inMinutes(60),
      handOff: false,
    });
    moves.stay(project.id);
    clock.advance(60 * 60_000);
    expect(getProject(state.db, project.id).accountId).toBe(second.id);
  });

  it('withdraws the card that told the builder about the move', () => {
    const moved = inbox.flag({
      projectId: project.id,
      workstreamId: null,
      ...movedCard(
        project,
        getAccountRow(state.db, plan),
        getAccount(state.db, second.id),
        { status: 'rejected', utilization: 1, limitType: 'five_hour', resetsAt: inMinutes(60) },
        [],
      ),
    });
    moves.move(project.id, second.id, {
      cause: MoveCause.UsageLimit,
      resetsAt: inMinutes(60),
      handOff: false,
    });
    clock.advance(60 * 60_000);
    expect(openCards().map((c) => c.id)).not.toContain(moved.id);
  });
});

describe('resuming an account from a card', () => {
  const refusal = {
    problem: 'signed_out',
    message: 'Claude Code reported no login for account "Claude plan"',
    seenIdentity: null,
  } as const;

  it('lifts the refusal and closes its card in every project on Resume', () => {
    const other = seedProject(store, { name: 'other', accountId: plan });
    runtime.refused(getAccountRow(state.db, plan), project.id, refusal);
    runtime.refused(getAccountRow(state.db, plan), other.id, refusal);
    const card = cardAbout(`${AccountPauseReason.Refused}:signed_out`);
    const answered = inbox.answer(card.id, { choice: AccountCardChoice.Resume });
    expect(answered).toMatchObject({ state: 'RESOLVED', answer: { choice: 'Resume' } });
    expect(pauses.pausedFor(plan)).toBeNull();
    expect(openCards()).toEqual([]);
  });

  it('lifts no other pause when a refusal card left open is answered Resume', () => {
    const stale = inbox.flag({
      projectId: project.id,
      workstreamId: null,
      ...refusedCard(getAccountRow(state.db, plan), refusal),
    });
    runtime.rateLimited(plan, inMinutes(60), project.id);
    inbox.answer(stale.id, { choice: AccountCardChoice.Resume });
    expect(pauses.pausedFor(plan)?.reason).toBe('usage_limit');
    expect(limitCard().state).toBe('OPEN');
  });
});
