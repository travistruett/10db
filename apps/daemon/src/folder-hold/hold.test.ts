import {
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  EventType,
  FolderAsker,
  FolderLimit,
  mintId,
  PassState,
  WorkstreamState,
  type ChatId,
  type DaemonEvent,
  type ProjectDto,
} from '@10db/contracts';
import {
  createTestStore,
  getChat,
  insertChat,
  insertConversation,
  insertPass,
  insertTask,
  insertWorkstream,
  schema,
  seedProject,
  type Store,
} from '@10db/db';
import { getEventListeners } from 'node:events';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type EventBus, type StateStore } from '../events';
import { holderWords } from './exclusion';
import {
  createFolderHold,
  FolderWaitCancelledError,
  type FolderAskerInput,
  type FolderHold,
} from './hold';

// Sessions spec §7.3: one answer to who has Your folder, from rows for a lane, a pass and a takeover and from
// memory for a chat's turn and 10db's git work, on a real store and bus.

let store: Store;
let close: () => void;
let state: StateStore;
let project: ProjectDto;
let events: DaemonEvent[];
let bus: EventBus;

beforeEach(() => {
  ({ store, close } = createTestStore());
  bus = createEventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  state = createStateStore(store, bus);
  project = seedProject(store);
});
afterEach(() => {
  close();
});

const newHold = (): FolderHold => createFolderHold({ state, bus });

function chat(
  title: string,
  conversationState: ConversationState = ConversationState.IdleCold,
): ChatId {
  return store.write((ctx) => {
    const id = mintId('Chat');
    const conv = insertConversation(ctx, {
      projectId: project.id,
      owner: { kind: ConversationOwnerKind.Chat, id },
      profile: ConversationProfile.Explore,
      state: conversationState,
    });
    return insertChat(ctx, {
      id,
      projectId: project.id,
      conversationId: conv.id,
      title,
      tabPosition: 0,
    }).id;
  }).value;
}

function lane(title: string): void {
  store.write((ctx) => {
    const task = insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: ['api'] });
    const ws = insertWorkstream(ctx, task.id, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    ctx.tx
      .update(schema.workstreams)
      .set({ state: WorkstreamState.Running, workspaceMode: 'shared' })
      .where(eq(schema.workstreams.id, ws.id))
      .run();
  });
}

function pass(name: string, passState: PassState): void {
  store.write((ctx) => {
    const task = insertTask(ctx, project.id, {
      title: 'Page',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    const opened = insertPass(ctx, {
      id: mintId('Pass'),
      projectId: project.id,
      name,
      pageCap: 4,
      returnBranch: 'main',
      startSha: 'a'.repeat(40),
      branch: '10db/pass-abc123',
      baseBranch: 'main',
      repo: null,
      taskIds: [task.id],
      dirt: [],
    });
    ctx.tx
      .update(schema.passes)
      .set({ state: passState })
      .where(eq(schema.passes.id, opened.pass.id))
      .run();
  });
}

const words = (hold: FolderHold, asker: FolderAskerInput): string[] =>
  hold.blockers(project.id, asker).map((b) => holderWords(b.holder));

describe('blockers', () => {
  const chatAsker = (id: ChatId): FolderAskerInput => ({ kind: FolderAsker.ChatTurn, chatId: id });

  it('is empty for every asker when nothing holds the folder', () => {
    const hold = newHold();
    const me = chat('Me');
    for (const asker of [
      { kind: FolderAsker.LaneStart },
      { kind: FolderAsker.GitWork },
      chatAsker(me),
    ] as const)
      expect(words(hold, asker)).toEqual([]);
  });

  it('names a running task to a chat, and counts the others', () => {
    lane('Bump vite');
    lane('Fix login');
    const hold = newHold();
    expect(words(hold, chatAsker(chat('Me')))).toEqual(['the task ‘Bump vite’ and 1 more']);
    // A lane's first start shares with lanes, and 10db's git work keeps today's checks for them.
    expect(words(hold, { kind: FolderAsker.LaneStart })).toEqual([]);
    expect(words(hold, { kind: FolderAsker.GitWork })).toEqual([]);
  });

  it('names an open pass to a chat and to a lane, and a closed pass only to a lane', () => {
    pass('Settings pass', PassState.Open);
    const hold = newHold();
    const me = chat('Me');
    expect(words(hold, chatAsker(me))).toEqual(['the pass ‘Settings pass’']);
    expect(words(hold, { kind: FolderAsker.LaneStart })).toEqual(['the pass ‘Settings pass’']);
  });

  it('lets a chat write while a closed pass waits, with the folder git limit', () => {
    pass('Settings pass', PassState.Closed);
    const hold = newHold();
    const me = chat('Me');
    expect(words(hold, chatAsker(me))).toEqual([]);
    expect(words(hold, { kind: FolderAsker.LaneStart })).toEqual([
      'the pass ‘Settings pass’ (until its pull request merges)',
    ]);
    expect(hold.takeTurn(project.id, me)).toEqual({
      taken: true,
      sharedWith: [],
      limits: [FolderLimit.FolderGitUntilMerge],
      limitPass: 'Settings pass',
    });
  });

  it('keeps a lane and a chat out of 10db’s git work, and git work out of both', () => {
    const hold = newHold();
    const a = chat('A');
    expect(hold.takeTurn(project.id, a).taken).toBe(true);
    expect(words(hold, { kind: FolderAsker.GitWork })).toEqual(['the chat ‘A’']);
    expect(words(hold, { kind: FolderAsker.LaneStart })).toEqual(['the chat ‘A’']);
    hold.releaseTurn(a);
    const git = hold.reserveGit(project.id, 'switching Your folder back to `main`');
    if (!git.reserved) throw new Error('git work was refused');
    expect(words(hold, chatAsker(a))).toEqual(['10db switching Your folder back to `main`']);
    expect(words(hold, { kind: FolderAsker.LaneStart })).toEqual([
      '10db switching Your folder back to `main`',
    ]);
    expect(hold.takeTurn(project.id, a)).toMatchObject({ taken: false });
    expect(hold.reserveGit(project.id, 'a second job')).toMatchObject({ reserved: false });
    hold.releaseGit(git.token);
    expect(hold.takeTurn(project.id, a).taken).toBe(true);
  });
});

describe('a turn', () => {
  it('is read-only behind a lane: the take is refused, naming the task', () => {
    lane('Bump vite');
    const hold = newHold();
    const result = hold.takeTurn(project.id, chat('Me'));
    expect(result.taken).toBe(false);
    expect(result.taken ? [] : result.blockers.map((b) => holderWords(b.holder))).toEqual([
      'the task ‘Bump vite’',
    ]);
  });

  it('is shared by two chats, each named to the other, and a chain keeps its hold', () => {
    const hold = newHold();
    const a = chat('Retry login');
    const b = chat('Fix tests');
    expect(hold.takeTurn(project.id, a)).toMatchObject({ taken: true, sharedWith: [] });
    const second = hold.takeTurn(project.id, b);
    expect(second.taken && second.sharedWith.map(holderWords)).toEqual(['the chat ‘Retry login’']);
    // The same chat taking again (a chained turn) changes nothing and is still told who it shares with.
    const again = hold.takeTurn(project.id, a);
    expect(again.taken && again.sharedWith.map(holderWords)).toEqual(['the chat ‘Fix tests’']);
    expect(hold.holdsTurn(a)).toBe(true);
    hold.releaseTurn(a);
    hold.releaseTurn(a);
    expect(hold.holdsTurn(a)).toBe(false);
    expect(hold.holdsTurn(b)).toBe(true);
  });

  it('shares with a chat taken over in the builder’s terminal, naming it', () => {
    chat('In terminal', ConversationState.TakenOver);
    const hold = newHold();
    const result = hold.takeTurn(project.id, chat('Me'));
    expect(result.taken && result.sharedWith.map(holderWords)).toEqual([
      'the chat ‘In terminal’ in your terminal',
    ]);
  });

  it('announces every change of who holds the folder', () => {
    const hold = newHold();
    const a = chat('A');
    events.length = 0;
    hold.takeTurn(project.id, a);
    hold.takeTurn(project.id, a);
    hold.releaseTurn(a);
    hold.releaseTurn(a);
    expect(events.map((e) => [e.type, e.entityId])).toEqual([
      [EventType.FolderHoldChanged, project.id],
      [EventType.FolderHoldChanged, project.id],
    ]);
  });
});

describe('a restart', () => {
  it('keeps a pass, a lane and a takeover from rows, and drops turns and reservations', () => {
    pass('Settings pass', PassState.Open);
    lane('Bump vite');
    chat('In terminal', ConversationState.TakenOver);
    const before = newHold();
    const a = chat('A');
    expect(before.takeTurn(project.id, a).taken).toBe(false);
    const after = newHold();
    expect(after.holders(project.id).map(holderWords)).toEqual([
      'the pass ‘Settings pass’',
      'the task ‘Bump vite’',
      'the chat ‘In terminal’ in your terminal',
    ]);
  });

  it('drops a memory turn and a git reservation', () => {
    const before = newHold();
    const a = chat('A');
    before.takeTurn(project.id, a);
    expect(before.holders(project.id)).toHaveLength(1);
    expect(newHold().holders(project.id)).toEqual([]);
    before.releaseTurn(a);
    expect(before.reserveGit(project.id, 'cutting a branch').reserved).toBe(true);
    expect(before.holders(project.id)).toHaveLength(1);
    expect(newHold().holders(project.id)).toEqual([]);
  });
});

describe('waiting', () => {
  /** A lane ends and says so, as the runner's transition does. */
  function laneEnds(): void {
    state.write((ctx) => {
      ctx.tx
        .update(schema.workstreams)
        .set({ state: WorkstreamState.Done })
        .where(eq(schema.workstreams.state, WorkstreamState.Running))
        .run();
      ctx.emit({
        type: EventType.WorkstreamChanged,
        entityType: 'workstream',
        entityId: 'wst_x',
        data: {},
      });
    });
  }
  const began = () => 'began' as const;

  it('serves a waiter inside the lane’s change, holding the folder for it first', () => {
    lane('Bump vite');
    const hold = newHold();
    const a = chat('A');
    const seen: string[][] = [];
    hold.wait(project.id, a, () => {
      seen.push(
        hold
          .blockers(project.id, { kind: FolderAsker.LaneStart })
          .map((b) => holderWords(b.holder)),
      );
      return 'began';
    });
    expect(hold.waiting(a)).toBe(true);
    // A lane's first start waits behind a waiting chat, naming it.
    expect(words(hold, { kind: FolderAsker.LaneStart })).toEqual(['the chat \u2018A\u2019']);
    laneEnds();
    expect(seen).toEqual([['the chat \u2018A\u2019']]);
    expect(hold.waiting(a)).toBe(false);
    expect(hold.holdsTurn(a)).toBe(true);
    hold.releaseTurn(a);
    expect(hold.holders(project.id)).toEqual([]);
  });

  it('serves two waiters in the order they waited', () => {
    lane('Bump vite');
    const hold = newHold();
    const a = chat('A');
    const b = chat('B');
    const order: string[] = [];
    hold.wait(project.id, a, () => (order.push('A'), began()));
    hold.wait(project.id, b, () => (order.push('B'), began()));
    laneEnds();
    expect(order).toEqual(['A', 'B']);
  });

  it.each([
    ['a retired chat is dropped', 'dropped' as const, false],
    [
      'a chat whose turn can’t start (paused account, update hold) keeps waiting',
      'kept' as const,
      true,
    ],
  ])('%s, and the reservation goes at once', (_name, result, stillWaiting) => {
    lane('Bump vite');
    const hold = newHold();
    const a = chat('A');
    hold.wait(project.id, a, () => result);
    laneEnds();
    expect(hold.holdsTurn(a)).toBe(false);
    expect(hold.waiting(a)).toBe(stillWaiting);
    expect(words(hold, { kind: FolderAsker.GitWork })).toEqual([]);
  });

  it('serves a kept waiter again when an account resumes', () => {
    const hold = newHold();
    const a = chat('A');
    let paused = true;
    hold.wait(project.id, a, () => (paused ? 'kept' : 'began'));
    expect(hold.waiting(a)).toBe(true);
    paused = false;
    state.write((ctx) => {
      ctx.emit({
        type: EventType.AccountResumed,
        entityType: 'account',
        entityId: 'acc_x',
        data: {},
      });
    });
    expect(hold.holdsTurn(a)).toBe(true);
    expect(hold.waiting(a)).toBe(false);
  });

  it('never takes a turn already running from a chat that also waits', () => {
    const hold = newHold();
    const a = chat('A');
    hold.takeTurn(project.id, a);
    hold.wait(project.id, a, () => 'dropped');
    hold.serveWaiters();
    expect(hold.holdsTurn(a)).toBe(true);
    // The wait is served once that turn ends.
    hold.releaseTurn(a);
    expect(hold.waiting(a)).toBe(false);
  });

  it('says nothing more while a waiter that cannot start stays kept', () => {
    const hold = newHold();
    const a = chat('A');
    hold.wait(project.id, a, () => 'kept');
    const changes = () => events.filter((e) => e.type === EventType.FolderHoldChanged).length;
    const before = changes();
    for (let i = 0; i < 3; i += 1) laneEnds();
    expect(hold.waiting(a)).toBe(true);
    expect(changes()).toBe(before);
  });

  it('serves at once a waiter that only chats are in front of', () => {
    const hold = newHold();
    const a = chat('A');
    const b = chat('B');
    hold.takeTurn(project.id, a);
    hold.wait(project.id, b, began);
    expect(hold.holdsTurn(b)).toBe(true);
  });

  it('is cleared when its chat takes the folder, and cancelling after serving releases', () => {
    lane('Bump vite');
    const hold = newHold();
    const a = chat('A');
    hold.wait(project.id, a, () => 'kept');
    laneEnds();
    expect(hold.takeTurn(project.id, a).taken).toBe(true);
    expect(hold.waiting(a)).toBe(false);
    hold.releaseTurn(a);

    const b = chat('B');
    hold.wait(project.id, b, began);
    expect(hold.holdsTurn(b)).toBe(true);
    hold.cancelWait(b);
    expect(hold.holdsTurn(b)).toBe(false);
    hold.cancelWait(b);
  });
});

describe('10db’s git work waiting for the folder', () => {
  it('keeps a new chat turn out while it waits, so chats sharing the folder cannot starve it', async () => {
    const hold = newHold();
    const a = chat('A');
    const b = chat('B');
    hold.takeTurn(project.id, a);
    const reserved = hold.reserveGitWhenFree(project.id, 'cutting a branch');
    const turn = hold.takeTurn(project.id, b);
    expect(turn.taken).toBe(false);
    expect(turn.taken ? [] : turn.blockers.map((x) => holderWords(x.holder))).toEqual([
      '10db cutting a branch',
    ]);
    hold.releaseTurn(a);
    hold.releaseGit(await reserved);
    expect(hold.takeTurn(project.id, b).taken).toBe(true);
  });

  it('rejects with a typed error when its signal aborts, before or during the wait', async () => {
    const hold = newHold();
    const a = chat('A');
    hold.takeTurn(project.id, a);
    const during = new AbortController();
    const waiting = hold.reserveGitWhenFree(project.id, 'cutting a branch', {
      signal: during.signal,
    });
    during.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'FolderWaitCancelledError' });
    const before = AbortSignal.abort();
    await expect(
      hold.reserveGitWhenFree(project.id, 'cutting a branch', { signal: before }),
    ).rejects.toBeInstanceOf(FolderWaitCancelledError);
  });

  it('leaves no abort listener on a signal once it has the folder', async () => {
    const hold = newHold();
    const a = chat('A');
    hold.takeTurn(project.id, a);
    const signal = new AbortController().signal;
    const reserved = hold.reserveGitWhenFree(project.id, 'cutting a branch', { signal });
    expect(getEventListeners(signal, 'abort')).toHaveLength(1);
    hold.releaseTurn(a);
    await reserved;
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('hands the reservation over inside the wake, so a take in the same tick is refused', async () => {
    const hold = newHold();
    const a = chat('A');
    const b = chat('B');
    hold.takeTurn(project.id, a);
    const reserved = hold.reserveGitWhenFree(project.id, 'cutting a branch');
    hold.releaseTurn(a);
    // Same tick as the release: no await has run, so the waiter has not resumed yet.
    expect(hold.holders(project.id).map((h) => h.what)).toEqual(['cutting a branch']);
    expect(hold.takeTurn(project.id, b).taken).toBe(false);
    hold.releaseGit(await reserved);
    expect(hold.takeTurn(project.id, b).taken).toBe(true);
  });

  it('releases a handed-over reservation whose signal aborted in the same tick', async () => {
    const hold = newHold();
    const a = chat('A');
    hold.takeTurn(project.id, a);
    const abort = new AbortController();
    const waiting = hold.reserveGitWhenFree(project.id, 'cutting a branch', {
      signal: abort.signal,
    });
    hold.releaseTurn(a);
    abort.abort();
    await expect(waiting).rejects.toBeInstanceOf(FolderWaitCancelledError);
    expect(hold.holders(project.id)).toEqual([]);
    expect(hold.reserveGit(project.id, 'next').reserved).toBe(true);
  });

  it('keeps a lane’s first start out while an open that waits with lanesWait waits, and not for other git work', async () => {
    const hold = newHold();
    const a = chat('A');
    hold.takeTurn(project.id, a);
    const other = hold.reserveGitWhenFree(project.id, 'cutting a branch');
    // Other git work that waits keeps chats out but not a lane.
    expect(
      hold.blockers(project.id, { kind: FolderAsker.LaneStart }).map((b) => b.holder.kind),
    ).toEqual(['chat_turn']);
    hold.releaseTurn(a);
    hold.releaseGit(await other);

    hold.takeTurn(project.id, a);
    const opening = hold.reserveGitWhenFree(project.id, 'opening a pass', {
      lanesWait: { passName: 'Polish' },
    });
    expect(hold.opening(project.id)).toBe('Polish');
    expect(
      hold
        .blockers(project.id, { kind: FolderAsker.LaneStart })
        .map((b) => [b.holder.kind, b.holder.what]),
    ).toEqual([
      ['chat_turn', null],
      ['git_work', 'opening a pass'],
    ]);
    // A chat's take is refused behind it too.
    expect(hold.takeTurn(project.id, chat('B')).taken).toBe(false);
    hold.releaseTurn(a);
    hold.releaseGit(await opening);
    expect(hold.opening(project.id)).toBeNull();
    expect(hold.blockers(project.id, { kind: FolderAsker.LaneStart })).toEqual([]);
  });

  it('serves waiting git work oldest first', async () => {
    const hold = newHold();
    const a = chat('A');
    hold.takeTurn(project.id, a);
    const order: string[] = [];
    const first = hold.reserveGitWhenFree(project.id, 'first').then((t) => {
      order.push('first');
      return t;
    });
    const second = hold.reserveGitWhenFree(project.id, 'second').then((t) => {
      order.push('second');
      return t;
    });
    hold.releaseTurn(a);
    hold.releaseGit(await first);
    hold.releaseGit(await second);
    expect(order).toEqual(['first', 'second']);
  });
});

describe('a takeover', () => {
  const taking = (hold: FolderHold, id: ChatId, calls: { entered: number }) =>
    hold.takeOver(project.id, id, () => {
      calls.entered += 1;
      setConversationState(id, ConversationState.TakenOver);
      return 'entered';
    });

  function setConversationState(chatId: ChatId, to: ConversationState): void {
    state.write((ctx) => {
      const row = getChat(ctx.tx, chatId);
      ctx.tx
        .update(schema.conversations)
        .set({ state: to })
        .where(eq(schema.conversations.id, row.conversationId))
        .run();
    });
  }

  it.each<[string, (hold: FolderHold, other: ChatId) => void, string]>([
    [
      'a lane',
      () => {
        lane('Bump vite');
      },
      'the task ‘Bump vite’',
    ],
    [
      'an open pass',
      () => {
        pass('Settings pass', PassState.Open);
      },
      'the pass ‘Settings pass’',
    ],
    [
      '10db’s git work holding',
      (hold) => {
        hold.reserveGit(project.id, 'cutting a branch');
      },
      '10db cutting a branch',
    ],
    [
      '10db’s git work waiting for a chat’s turn',
      (hold, other) => {
        hold.takeTurn(project.id, other);
        void hold.reserveGitWhenFree(project.id, 'cutting a branch');
      },
      '10db cutting a branch',
    ],
  ])('is refused behind %s, with the holder named, and enters nothing', (_name, arrange, named) => {
    const hold = newHold();
    const me = chat('Me');
    const other = chat('Other');
    arrange(hold, other);
    const calls = { entered: 0 };
    const result = taking(hold, me, calls);
    expect(result.taken).toBe(false);
    expect(result.taken ? [] : result.blockers.map((b) => holderWords(b.holder))).toContain(named);
    expect(calls.entered).toBe(0);
  });

  it('shares with a closed pass, another chat’s turn and another takeover, naming the chats', () => {
    pass('Settings pass', PassState.Closed);
    chat('In terminal', ConversationState.TakenOver);
    const hold = newHold();
    const other = chat('Other');
    hold.takeTurn(project.id, other);
    const calls = { entered: 0 };
    const result = taking(hold, chat('Me'), calls);
    expect(result).toMatchObject({
      taken: true,
      value: 'entered',
      limits: [FolderLimit.FolderGitUntilMerge],
      limitPass: 'Settings pass',
    });
    expect(result.taken && result.sharedWith.map(holderWords)).toEqual([
      'the chat ‘In terminal’ in your terminal',
      'the chat ‘Other’',
    ]);
    expect(calls.entered).toBe(1);
  });

  it('announces the take once, and nothing when the entering throws', () => {
    const hold = newHold();
    const me = chat('Me');
    events.length = 0;
    expect(() =>
      hold.takeOver(project.id, me, () => {
        throw new Error('refused');
      }),
    ).toThrow('refused');
    expect(events).toEqual([]);
    expect(hold.holders(project.id)).toEqual([]);
    taking(hold, me, { entered: 0 });
    expect(events.map((e) => e.type)).toEqual([EventType.FolderHoldChanged]);
    expect(hold.holders(project.id).map(holderWords)).toEqual(['the chat ‘Me’ in your terminal']);
  });

  it('hands the folder to waiting git work before the chat’s own held message', async () => {
    const hold = newHold();
    const me = chat('Me');
    taking(hold, me, { entered: 0 });
    const git = hold.reserveGitWhenFree(project.id, 'switching Your folder back to `main`');
    let served = 0;
    hold.wait(project.id, me, () => {
      served += 1;
      return 'began';
    });
    expect(served).toBe(0);
    events.length = 0;
    hold.handBack(project.id, me, () => {
      setConversationState(me, ConversationState.IdleCold);
    });
    // In the same tick: the git work holds, and the chat is still waiting behind it.
    expect(hold.holders(project.id).map((h) => h.what)).toContain(
      'switching Your folder back to `main`',
    );
    expect(served).toBe(0);
    expect(hold.waiting(me)).toBe(true);
    expect(events.some((e) => e.type === EventType.FolderHoldChanged)).toBe(true);
    hold.releaseGit(await git);
    expect(served).toBe(1);
    expect(hold.holdsTurn(me)).toBe(true);
  });

  it('serves the chat’s waiter and leaves no git holder when the job aborts in the handover’s tick', async () => {
    const hold = newHold();
    const me = chat('Me');
    taking(hold, me, { entered: 0 });
    const abort = new AbortController();
    const git = hold.reserveGitWhenFree(project.id, 'cutting a branch', { signal: abort.signal });
    let served = 0;
    hold.wait(project.id, me, () => {
      served += 1;
      return 'began';
    });
    hold.handBack(project.id, me, () => {
      setConversationState(me, ConversationState.IdleCold);
    });
    abort.abort();
    await expect(git).rejects.toBeInstanceOf(FolderWaitCancelledError);
    expect(hold.holders(project.id).map((h) => h.kind)).toEqual(['chat_turn']);
    expect(served).toBe(1);
  });

  it('serves a waiter at Hand Back when no git work waits, and lets a lane start after', () => {
    const hold = newHold();
    const me = chat('Me');
    taking(hold, me, { entered: 0 });
    let served = 0;
    hold.handBack(project.id, me, () => {
      setConversationState(me, ConversationState.IdleCold);
    });
    hold.wait(project.id, me, () => {
      served += 1;
      return 'began';
    });
    expect(served).toBe(1);
    expect(words(hold, { kind: FolderAsker.LaneStart })).toEqual(['the chat ‘Me’']);
  });
});
