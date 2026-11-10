import {
  InboxAnswerRefused,
  SHARED_ASK_ALLOW_CHOICE,
  SHARED_ASK_KEEP_CHOICE,
  SHARED_ASK_REPLY_CHOICE,
  SharedAskDetail,
  sharedAskFoldKey,
  type InboxItemId,
  type TaskDto,
  type TaskId,
  type TaskMessageId,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  findToolOp,
  getHold,
  getInboxItem,
  getWorkstreamRow,
  insertSession,
  insertTakeOut,
  listSharedChanges,
  listTaskThread,
  listTaskThreadRows,
  openHolds,
  openPassTurn,
} from '@10db/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { silentLogger } from '../log';
import { closeHoldsOf, grantSharedHold, keepHold, landSharedChanges, sharedRef } from '../pass';
import { ClaimWaits } from './claim-wait';
import { createToolHandlers } from './tools';

// Workbench spec §7.2: a pass lane asks for a shared area with request_claim, and gets it for the
// turn with a hold that records what the area held at the grant.

let w: PassWorld;
afterEach(() => {
  w.close();
});

/** The task's lane tools, as its session's MCP server builds them, sharing `waits`. */
function laneTools(
  world: PassWorld,
  task: TaskDto,
  waits: ClaimWaits,
  sliceMs?: number,
  deliverMessage?: (taskId: TaskId, messageId: TaskMessageId) => Promise<void>,
) {
  const workstreamId = world.runOf(task);
  // The lane is in a turn, as an agent calling a tool is.
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
      ...(sliceMs === undefined ? {} : { claimWaitSliceMs: sliceMs }),
      ...(deliverMessage === undefined ? {} : { deliverMessage }),
    },
    session.id,
    workstreamId,
    waits,
  );
}

describe('request_claim for a shared area in a pass', () => {
  it('grants the first task the area with its hold', async () => {
    w = await openPassWorld();
    const tools = laneTools(w, w.settings, new ClaimWaits());

    const answer = await tools.request_claim({
      opId: 'op-src-1',
      kind: 'area',
      name: 'src',
      reason: 'a shared button',
    });

    expect(answer.granted).toBe(true);
    const holds = openHolds(w.h.store.db, w.opened.pass.id);
    expect(holds).toHaveLength(1);
    expect(answer).toEqual({ granted: true, claimId: holds[0]?.claimId });
  });
});

describe('the commit tool under a shared hold', () => {
  it('keeps shared paths on the chain early, the turn end keeps them again, and they land', async () => {
    w = await openPassWorld();
    const { h } = w;
    const tools = laneTools(w, w.settings, new ClaimWaits());
    const granted = await tools.request_claim({
      opId: 'op-src-1',
      kind: 'area',
      name: 'src',
      reason: 'a shared button',
    });
    if (!granted.granted) throw new Error('src was not granted');
    w.write('src/button.ts', 'button\n');

    const early = await tools.commit({
      opId: 'op-c-1',
      paths: ['src/button.ts'],
      message: 'Button',
    });

    const chain = sharedRef(w.opened.pass.id);
    expect(early).toEqual({ sha: h.git$('rev-parse', chain), alreadyCommitted: false });
    expect(h.git$('rev-parse', 'HEAD')).toBe(w.opened.pass.startSha);
    expect(getHold(h.store.db, granted.claimId).closedAt).toBeNull();
    expect(listSharedChanges(h.store.db, w.opened.pass.id)[0]?.sha).toBe(early.sha);

    w.write('src/button.ts', 'button, edited after the commit\n');
    await closeHoldsOf(w.deps, w.runOf(w.settings));

    const [change] = listSharedChanges(h.store.db, w.opened.pass.id);
    expect(change?.sha).not.toBe(early.sha);
    expect(change?.sha).toBe(h.git$('rev-parse', chain));
    expect(h.git$('rev-parse', `${chain}^`)).toBe(early.sha);
    expect(getHold(h.store.db, granted.claimId).closedAt).not.toBeNull();
    await landSharedChanges(w.deps, { passId: w.opened.pass.id, upTo: 1 });
    expect(h.git$('show', `${w.branch}:src/button.ts`)).toBe('button, edited after the commit');
    expect(h.git$('log', '-1', '--format=%s', w.branch)).toBe(
      'Shared change 1 of Settings: UI work',
    );
  });
});

describe("the builder's question before a second task changes a shared area", () => {
  /** Settings changes `src/button.ts` in a turn of its own, so People's ask needs the builder. */
  async function settingsChangedSrc(): Promise<void> {
    w.startTurn(w.settings);
    const granted = await grantSharedHold(w.deps, {
      workstreamId: w.runOf(w.settings),
      area: 'src',
    });
    if (!granted?.ok) throw new Error('src was not granted');
    w.write('src/button.ts', 'button\n');
    const [hold] = openHolds(w.h.store.db, w.opened.pass.id);
    if (!hold) throw new Error('no hold');
    await keepHold(w.deps, { claimId: hold.claimId });
  }
  const ask = (tools: ReturnType<typeof laneTools>) =>
    tools.request_claim({
      opId: 'op-people-src',
      kind: 'area',
      name: 'src',
      reason: 'a wider button',
    });

  it('waits for the answer across calls, and Allow grants the area', async () => {
    w = await openPassWorld();
    await settingsChangedSrc();
    const tools = laneTools(w, w.people, new ClaimWaits(), 30);

    const first = await ask(tools);

    expect(first).toMatchObject({ granted: false, waiting: true, heldBy: null });
    if (first.granted || first.inboxId === null) throw new Error('no question');
    expect(first.instruction).toMatch(/Waiting for the builder's answer/);
    const card = getInboxItem(w.h.store.db, first.inboxId);
    expect(card).toMatchObject({
      kind: 'question',
      state: 'OPEN',
      title: 'People: UI work wants to change shared code in src',
    });
    expect(
      findOpenByFoldKey(w.h.store.db, w.h.project.id, sharedAskFoldKey(w.runOf(w.people), 'src'))
        ?.id,
    ).toBe(first.inboxId);
    expect(card.body).toMatch(/^Settings: UI work changed `src\/button.ts` there /);
    expect(card.options.map((o) => o.label)).toEqual([
      SHARED_ASK_ALLOW_CHOICE,
      SHARED_ASK_KEEP_CHOICE,
      SHARED_ASK_REPLY_CHOICE,
      'Park the task',
    ]);
    expect(SharedAskDetail.parse(card.detail).others).toMatchObject([
      { taskId: w.settings.id, paths: ['src/button.ts'], holdsNow: false },
    ]);

    // The agent calls again with the same opId, and the answer comes while it waits.
    const second = ask(tools);
    w.h.inbox.answer(first.inboxId, { choice: SHARED_ASK_ALLOW_CHOICE });

    const granted = await second;
    expect(granted.granted).toBe(true);
    expect(openHolds(w.h.store.db, w.opened.pass.id)).toMatchObject([
      { taskId: w.people.id, area: 'src', seq: 2 },
    ]);
  });

  it.each<{ name: string; choice: string; note?: string; told: RegExp; thread: string | null }>([
    {
      name: 'Keep It to This Page',
      choice: SHARED_ASK_KEEP_CHOICE,
      told: /Keep this change inside your page/,
      thread: null,
    },
    {
      name: 'a reply',
      choice: SHARED_ASK_REPLY_CHOICE,
      note: 'Use the page button instead',
      told: /"Use the page button instead"/,
      thread: 'Use the page button instead',
    },
    {
      name: 'Park the task',
      choice: 'Park the task',
      told: /Keep this change inside your page/,
      thread:
        'The question about shared src was answered with Park the task, which in a pass keeps the change to this page: the page stays in the pass.',
    },
  ])(
    'answers $name with no claim, kept for the next call',
    async ({ choice, note, told, thread }) => {
      w = await openPassWorld();
      await settingsChangedSrc();
      const tools = laneTools(w, w.people, new ClaimWaits(), 30);
      const first = await ask(tools);
      if (first.granted || first.inboxId === null) throw new Error('no question');

      // The answer comes while no call waits; the next call with the same opId gets it.
      w.h.inbox.answer(first.inboxId, { choice, ...(note === undefined ? {} : { note }) });
      await new Promise((r) => setImmediate(r));
      const answer = await ask(tools);

      expect(answer).toMatchObject({ granted: false, waiting: false, inboxId: first.inboxId });
      if (answer.granted) throw new Error('granted');
      expect(answer.instruction).toMatch(told);
      expect(openHolds(w.h.store.db, w.opened.pass.id)).toEqual([]);
      const said = listTaskThread(w.h.store.db, w.people.id).map((m) => m.body);
      if (thread !== null) expect(said).toContain(thread);
      // The page stays in its pass, its run going on.
      expect(getWorkstreamRow(w.h.store.db, w.runOf(w.people)).state).not.toBe('CANCELLED');
      if (choice === SHARED_ASK_REPLY_CHOICE)
        expect(listTaskThread(w.h.store.db, w.people.id).at(-1)).toMatchObject({
          author: 'builder',
          body: note,
        });
    },
  );

  it('hands a reply that comes after the turn ended to the next turn, not to nobody', async () => {
    w = await openPassWorld();
    await settingsChangedSrc();
    const delivered: TaskMessageId[] = [];
    const tools = laneTools(w, w.people, new ClaimWaits(), 30, (_task, id) => {
      delivered.push(id);
      return Promise.resolve();
    });
    const first = await ask(tools);
    if (first.granted || first.inboxId === null) throw new Error('no question');
    // The turn's end write has happened; its step 2 has not yet withdrawn the question.
    const turn = openPassTurn(w.h.store.db, w.people.id);
    if (!turn) throw new Error('no turn');
    w.endTurn(turn);

    w.h.inbox.answer(first.inboxId, { choice: SHARED_ASK_REPLY_CHOICE, note: 'Use the page one' });
    await vi.waitFor(() => {
      expect(delivered).toHaveLength(1);
    });

    const message = listTaskThread(w.h.store.db, w.people.id).at(-1);
    expect(message).toMatchObject({ author: 'builder', body: 'Use the page one' });
    expect(delivered).toEqual([message?.id]);
    expect(listTaskThreadRows(w.h.store.db, w.people.id).at(-1)?.deliveredAt).toBeNull();
  });

  it("never keeps a parked holder's refusal under the opId", async () => {
    w = await openPassWorld();
    // Settings holds the area now, and the update drain has parked it.
    w.startTurn(w.settings);
    await grantSharedHold(w.deps, { workstreamId: w.runOf(w.settings), area: 'src' });
    const waits = new ClaimWaits({ parked: () => true });
    const tools = laneTools(w, w.people, waits, 30);
    const first = await ask(tools);
    if (first.granted || first.inboxId === null) throw new Error('no question');

    w.h.inbox.answer(first.inboxId, { choice: SHARED_ASK_ALLOW_CHOICE });
    await new Promise((r) => setImmediate(r));
    expect(findToolOp(w.h.store.db, w.runOf(w.people), 'op-people-src')).toBeUndefined();

    // The same opId asks again, since the holder is still there: nothing kept answers it.
    expect(await ask(tools)).toMatchObject({ granted: false, waiting: true });
  });

  it('refuses a reply with no words, and passes a note given with Keep It to This Page on', async () => {
    w = await openPassWorld();
    await settingsChangedSrc();
    const tools = laneTools(w, w.people, new ClaimWaits(), 30);
    const first = await ask(tools);
    if (first.granted || first.inboxId === null) throw new Error('no question');
    const card = first.inboxId;

    expect(() => w.h.inbox.answer(card, { choice: SHARED_ASK_REPLY_CHOICE, note: '  ' })).toThrow(
      InboxAnswerRefused,
    );
    expect(getInboxItem(w.h.store.db, card).state).toBe('OPEN');

    const answer = ask(tools);
    w.h.inbox.answer(card, { choice: SHARED_ASK_KEEP_CHOICE, note: 'Style it in the page' });
    const kept = await answer;
    if (kept.granted) throw new Error('granted');
    expect(kept.instruction).toMatch(/The builder added: "Style it in the page"/);
  });

  it('sends no late reply to a page being taken out, and says so on its thread', async () => {
    w = await openPassWorld();
    await settingsChangedSrc();
    const delivered: TaskMessageId[] = [];
    const tools = laneTools(w, w.people, new ClaimWaits(), 30, (_task, id) => {
      delivered.push(id);
      return Promise.resolve();
    });
    const first = await ask(tools);
    if (first.granted || first.inboxId === null) throw new Error('no question');
    const turn = openPassTurn(w.h.store.db, w.people.id);
    if (!turn) throw new Error('no turn');
    w.endTurn(turn);
    w.h.state.write((c) =>
      insertTakeOut(c, { taskId: w.people.id, passId: w.opened.pass.id, drops: [] }),
    );

    w.h.inbox.answer(first.inboxId, { choice: SHARED_ASK_REPLY_CHOICE, note: 'Use the page one' });
    await vi.waitFor(() => {
      expect(listTaskThread(w.h.store.db, w.people.id).at(-1)?.body).toMatch(
        /^Your reply about shared src came after the page's turn ended/,
      );
    });

    expect(delivered).toEqual([]);
    expect(
      listTaskThread(w.h.store.db, w.people.id).some(
        (m) => m.author === 'builder' && m.body === 'Use the page one',
      ),
    ).toBe(false);
  });

  it.each<{ name: string; end: (card: InboxItemId) => void; told: RegExp }>([
    {
      name: 'its turn ends and the next opens',
      end: () => {
        const turn = openPassTurn(w.h.store.db, w.people.id);
        if (!turn) throw new Error('no turn');
        w.endTurn(turn);
        w.startTurn(w.people);
      },
      told: /Your turn ended before shared area src was granted/,
    },
    {
      name: 'its question is withdrawn',
      end: (card) => {
        w.h.inbox.withdraw(card);
      },
      told: /was closed without an answer/,
    },
  ])('ends the wait with nothing when $name', async ({ end, told }) => {
    w = await openPassWorld();
    await settingsChangedSrc();
    const tools = laneTools(w, w.people, new ClaimWaits(), 30);
    const first = await ask(tools);
    if (first.granted || first.inboxId === null) throw new Error('no question');

    end(first.inboxId);

    await vi.waitFor(() => {
      const kept = findToolOp(w.h.store.db, w.runOf(w.people), 'op-people-src');
      expect(JSON.stringify(kept?.result)).toMatch(told);
    });
    expect(openHolds(w.h.store.db, w.opened.pass.id)).toEqual([]);
  });
});
