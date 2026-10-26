import {
  AccountCardChoice,
  AccountPauseReason,
  InvalidError,
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
  createAccountMoves,
  createAccountPauses,
  createAccountRuntime,
  createMoveBack,
  MOVE_BACK_CARD,
  MoveCause,
  type AccountMoves,
  type AccountPauses,
  type AccountRuntime,
  type MoveBack,
} from './index';

const DEFAULT_PAUSE_MS = 30 * 60_000;

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let inbox: InboxService;
let pauses: AccountPauses;
let runtime: AccountRuntime;
let moveBack: MoveBack;
let moves: AccountMoves;
let answerCard: (item: InboxItemDto, answer: InboxAnswer) => void;
let ticks: number;
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
  moveBack = createMoveBack({ state, clock, inbox, pauses, defaultPauseMs: DEFAULT_PAUSE_MS });
  moves = createAccountMoves({
    state,
    inbox,
    pauses,
    moveBack,
    onMoved: () => {
      ticks += 1;
    },
  });
  answerCard = createAccountCardAnswers({
    resume: () => undefined,
    confirm: () => undefined,
    move: (projectId, to, why, answering) => {
      moves.move(projectId, to, why, { answering });
    },
    stay: (projectId) => {
      moves.stay(projectId);
    },
  });
}

beforeEach(() => {
  clock = new ManualClock(new Date(2026, 9, 20, 12));
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

  it('asks once the limit resets whether to move back, and moves back on Move back', () => {
    runtime.rateLimited(plan, inMinutes(60), project.id);
    // A move by PATCH while the account is paused for its usage limit is remembered too.
    moves.move(project.id, second.id, { cause: MoveCause.Builder });
    expect(getProject(state.db, project.id).movedFromAccountId).toBe(plan);
    // The usage-limit card offered a move the builder has made another way.
    expect(openCards()).toEqual([]);

    clock.advance(60 * 60_000);
    const back = backCard();
    expect(back.title).toBe('Claude plan is available again: move demo back?');
    expect(back.body).toContain('that limit has reset');
    expect(back.options.map((o) => o.label)).toEqual(['Move back', 'Stay']);
    inbox.answer(back.id, { choice: AccountCardChoice.MoveBack });
    expect(getProject(state.db, project.id)).toMatchObject({
      accountId: plan,
      movedFromAccountId: null,
      moveBackAt: null,
    });
  });

  it('stays where it is on Stay, and forgets the move back', () => {
    runtime.rateLimited(plan, inMinutes(60), project.id);
    inbox.answer(limitCard().id, { choice: CONTINUE });
    clock.advance(60 * 60_000);
    inbox.answer(backCard().id, { choice: AccountCardChoice.Stay });
    expect(getProject(state.db, project.id)).toMatchObject({
      accountId: second.id,
      movedFromAccountId: null,
      moveBackAt: null,
    });
  });

  it('waits while the account it left is still paused, and asks when that pause ends', () => {
    const stayer = seedProject(store, { name: 'stayer' });
    runtime.rateLimited(plan, inMinutes(60), project.id);
    inbox.answer(limitCard().id, { choice: CONTINUE });
    // A session of a project still on the account meets the limit again, later.
    runtime.rateLimited(plan, inMinutes(120), stayer.id);
    clock.advance(60 * 60_000);
    expect(
      findOpenByFoldKey(state.db, project.id, accountFoldKey(plan, MOVE_BACK_CARD)),
    ).toBeUndefined();
    clock.advance(60 * 60_000);
    expect(backCard().projectId).toBe(project.id);
  });

  it('asks after the default pause, and says so, when nobody reported when the limit resets', () => {
    moves.move(project.id, second.id, { cause: MoveCause.UsageLimit, resetsAt: null });
    expect(getProject(state.db, project.id)).toMatchObject({
      movedFromAccountId: plan,
      moveBackAt: null,
    });
    clock.advance(DEFAULT_PAUSE_MS);
    expect(backCard().body).toContain("10db doesn't know whether that limit has reset");
  });

  it('raises a move back that came due while the daemon was down', () => {
    runtime.rateLimited(plan, inMinutes(60), project.id);
    inbox.answer(limitCard().id, { choice: CONTINUE });
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
});
