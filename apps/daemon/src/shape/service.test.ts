import {
  ConflictError,
  mintId,
  PlanDraft,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeProposalState,
  ShapeToolInputs,
  type ShapeId,
  type ShapeMessageDto,
} from '@10db/contracts';
import {
  getSession,
  getShape,
  getShapeSdkSessionId,
  listShapeMessages,
  listShapeProposals,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { FakeAdapter, type FakeShapeBehaviour, type FakeShapeTurn } from '../sessions';
import {
  looseDraft,
  must,
  seedConversation,
  type ConversationFixture,
} from './conversation-fixture';
import { createShapeService, type ShapeService } from './service';

// Shape spec §5.1, §5.3, §11: one turn at a time, the Propose and Convert guards, the move to a
// fresh session past 70% of the context, resume and the idle close.

let c: ConversationFixture;
let state: StateStore;
let adapter: FakeAdapter;
let clock: ManualClock;
let service: ShapeService;
let shapeId: ShapeId;
beforeEach(() => {
  c = seedConversation();
  state = createStateStore(c.store, createEventBus());
  adapter = new FakeAdapter({});
  clock = new ManualClock();
  shapeId = c.shape.id;
  service = createShapeService({
    state,
    adapter,
    clock,
    log: silentLogger,
    mcp: { url: 'http://127.0.0.1:4317/mcp', toolTimeoutMs: 60_000 },
    launch: () => ({
      cwd: '/repo',
      model: 'opus',
      effort: 'high',
      env: {},
      account: {
        accountId: mintId('Account'),
        label: 'Claude plan',
        kind: 'claude_subscription',
        identity: null,
      },
      access: {
        checkout: '/repo',
        home: '/home',
        protectedReads: [],
        filesDir: '/files',
        tempRoot: '/tmp/10db',
      },
    }),
  });
});
afterEach(async () => {
  await service.close();
  c.close();
});

interface Gate {
  readonly open: () => void;
  readonly wait: Promise<void>;
}
function gate(): Gate {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

/** Lets pending work run: events cross an async channel before the service sees them. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const transcript = (): ShapeMessageDto[] => listShapeMessages(c.store.db, shapeId);
const notices = (): string[] =>
  transcript()
    .filter((m) => m.kind === ShapeMessageKind.Notice)
    .map((m) => m.body);

/** A turn that calls propose_plan with loose tasks citing the builder's first message. */
const proposing =
  (source: string, ...keys: string[]): FakeShapeBehaviour =>
  async (turn) => {
    const handler = service.toolsFor({ sessionId: turn.spec.sessionId, shapeId }).propose_plan;
    await must(
      handler,
      'propose_plan',
    )(
      ShapeToolInputs.propose_plan.parse({
        draft: PlanDraft.parse(looseDraft(source as never, ...keys)),
      }),
    );
    return { text: 'Proposed.' };
  };

describe('a message', () => {
  it('starts a session on the conversation with the message under its id, and stores the reply', async () => {
    const reply = gate();
    adapter.shapeBehaviour = async () => {
      await reply.wait;
      return { text: 'The board has a grid.' };
    };
    const sent = service.send(shapeId, 'Make the board denser.');
    await tick();
    const session = must(adapter.shapeSessions[0], 'a session');
    expect(session.spec.prompt).toBe(`[m:${sent.id}] Make the board denser.`);
    expect(session.spec.resumeProviderSessionId).toBeNull();
    expect(session.spec.shapeId).toBe(shapeId);
    expect(session.spec.tools).toEqual(['Read', 'Grep', 'Glob', 'Agent']);
    expect(session.spec.disallowedTools).toContain('Bash');
    expect(session.spec.systemPrompt).toMatch(/note_heard/);
    const row = getSession(c.store.db, session.spec.sessionId);
    expect(row).toMatchObject({ shapeId, workstreamId: null, endedAt: null });
    reply.open();
    await service.settled(shapeId);
    const claude = transcript().filter((m) => m.author === ShapeMessageAuthor.Claude);
    expect(claude.map((m) => m.body)).toEqual(['The board has a grid.']);
    expect(getShapeSdkSessionId(c.store.db, shapeId)).toBe('fake-shape-1');
    expect(getSession(c.store.db, session.spec.sessionId).inputTokens).toBeGreaterThan(0);
  });

  it('goes to the same session, one turn at a time, in the order sent', async () => {
    const first = gate();
    const seen: string[] = [];
    let running = 0;
    let most = 0;
    adapter.shapeBehaviour = async (turn: FakeShapeTurn) => {
      running += 1;
      most = Math.max(most, running);
      seen.push(turn.message);
      if (turn.number === 1) await first.wait;
      running -= 1;
      return { text: `reply ${String(turn.number)}` };
    };
    const a = service.send(shapeId, 'one');
    const b = service.send(shapeId, 'two');
    await tick();
    expect(seen).toEqual([`[m:${a.id}] one`]);
    first.open();
    await service.settled(shapeId);
    expect(seen).toEqual([`[m:${a.id}] one`, `[m:${b.id}] two`]);
    expect(most).toBe(1);
    expect(adapter.shapeSessions).toHaveLength(1);
  });

  it('is interrupted by Stop, and the queue runs next', async () => {
    adapter.shapeBehaviour = (turn) =>
      turn.number === 1
        ? new Promise((_resolve, reject) => {
            turn.signal.addEventListener('abort', () => {
              reject(new Error('interrupted'));
            });
          })
        : Promise.resolve({ text: 'second' });
    service.send(shapeId, 'one');
    const b = service.send(shapeId, 'two');
    await tick();
    await service.stop(shapeId);
    await service.settled(shapeId);
    expect(must(adapter.shapeSessions[0], 'a session').sent).toEqual([`[m:${b.id}] two`]);
    expect(
      transcript()
        .filter((m) => m.author === ShapeMessageAuthor.Claude)
        .map((m) => m.body),
    ).toEqual(['second']);
  });
});

describe('Propose', () => {
  it('unlocks propose_plan for good, notes the press, and tells the session to propose', async () => {
    const m = c.say();
    adapter.shapeBehaviour = proposing(m, 'a', 'b');
    expect(service.propose(shapeId)).toEqual({ status: 'started' });
    await service.settled(shapeId);
    expect(getShape(c.store.db, shapeId).proposeUnlocked).toBe(true);
    const session = must(adapter.shapeSessions[0], 'a session');
    expect(session.spec.prompt).toMatch(/pressed Propose/);
    expect(session.spec.prompt).toMatch(/propose_plan/);
    expect(transcript().some((t) => t.kind === ShapeMessageKind.Propose)).toBe(true);
    expect(listShapeProposals(c.store.db, shapeId).map((r) => r.key)).toEqual(['a', 'b']);
    expect(notices()).toEqual([]);
  });

  it('is ignored while a Propose turn is running, and while one is queued', async () => {
    const m = c.say();
    const hold = gate();
    let turns = 0;
    adapter.shapeBehaviour = async (turn) => {
      turns += 1;
      if (turn.number === 1) await hold.wait;
      return proposing(m, 'a')(turn);
    };
    expect(service.propose(shapeId)).toEqual({ status: 'started' });
    await tick();
    expect(service.propose(shapeId)).toEqual({ status: 'ignored' });
    hold.open();
    await service.settled(shapeId);
    expect(turns).toBe(1);
    expect(transcript().filter((t) => t.kind === ShapeMessageKind.Propose)).toHaveLength(1);

    // A press behind a message turn queues once; a second press is ignored too.
    const slow = gate();
    adapter.shapeBehaviour = async () => {
      await slow.wait;
      return { text: 'ok' };
    };
    service.send(shapeId, 'more');
    await tick();
    expect(service.propose(shapeId)).toEqual({ status: 'started' });
    expect(service.propose(shapeId)).toEqual({ status: 'ignored' });
    slow.open();
    await service.settled(shapeId);
    // After it ran, a new press is accepted again. From round 1 the press reads Propose Again.
    expect(service.propose(shapeId)).toEqual({ status: 'started' });
    await service.settled(shapeId);
    const presses = transcript().filter((t) => t.kind === ShapeMessageKind.Propose);
    expect(presses.map((p) => p.body)).toEqual(['Propose', 'Propose Again', 'Propose Again']);
  });

  it('shows a notice when the turn ends with no accepted propose_plan', async () => {
    c.say();
    adapter.shapeBehaviour = () => Promise.resolve({ text: 'Let me think about it.' });
    service.propose(shapeId);
    await service.settled(shapeId);
    expect(notices()).toEqual(["Claude didn't propose; Propose Again"]);
  });

  it('shows the notice when every propose_plan of the turn was refused', async () => {
    c.say();
    adapter.shapeBehaviour = async (turn) => {
      const handler = service.toolsFor({ sessionId: turn.spec.sessionId, shapeId }).propose_plan;
      await must(
        handler,
        'propose_plan',
      )(
        ShapeToolInputs.propose_plan.parse({
          draft: PlanDraft.parse(looseDraft(mintId('ShapeMessage'), 'a')),
        }),
      ).catch(() => undefined);
      return { text: 'tried' };
    };
    service.propose(shapeId);
    await service.settled(shapeId);
    expect(notices()).toEqual(["Claude didn't propose; Propose Again"]);
    expect(listShapeProposals(c.store.db, shapeId)).toEqual([]);
  });
});

describe('Convert', () => {
  async function proposed(): Promise<string[]> {
    const m = c.say();
    adapter.shapeBehaviour = proposing(m, 'a', 'b');
    service.propose(shapeId);
    await service.settled(shapeId);
    return listShapeProposals(c.store.db, shapeId).map((r) => r.id);
  }

  it('creates once for a double Convert and answers the second with what the first made', async () => {
    const ids = (await proposed()) as never[];
    const first = await service.convert(shapeId, ids);
    const second = await service.convert(shapeId, ids);
    expect(first).toMatchObject({ ok: true, createdNow: 2 });
    expect(second).toMatchObject({ ok: true, createdNow: 0 });
    expect(second.ok && second.results).toEqual(first.ok && first.results);
    expect(
      listShapeProposals(c.store.db, shapeId).every((r) => r.state === ShapeProposalState.Accepted),
    ).toBe(true);
  });

  it('is refused with 409 while a turn runs, unless it interrupts the turn', async () => {
    const ids = (await proposed()) as never[];
    adapter.shapeBehaviour = (turn) =>
      new Promise((_resolve, reject) => {
        turn.signal.addEventListener('abort', () => {
          reject(new Error('interrupted'));
        });
      });
    service.send(shapeId, 'talking');
    await tick();
    await expect(service.convert(shapeId, ids)).rejects.toThrow(ConflictError);
    await expect(service.convert(shapeId, ids)).rejects.toThrow(
      'Claude is still answering; Stop or wait',
    );
    expect(listShapeProposals(c.store.db, shapeId).every((r) => r.state === 'pending')).toBe(true);
    const outcome = await service.convert(shapeId, ids, { interrupt: true });
    expect(outcome).toMatchObject({ ok: true, createdNow: 2 });
  });

  it('holds the queue while it runs and answers a refusal without starting a turn', async () => {
    const ids = (await proposed()) as never[];
    const outcome = await service.convert(shapeId, [ids[0] as never, mintId('ShapeProposal')]);
    expect(outcome.ok).toBe(false);
    expect(adapter.shapeSessions).toHaveLength(1);
  });
});

describe('a long conversation', () => {
  it('continues in a fresh session past 70% of the context, seeded with the digest', async () => {
    adapter.shapeBehaviour = (turn) =>
      Promise.resolve({ text: `reply ${String(turn.number)}`, contextPercent: 71 });
    const a = service.send(shapeId, 'first thing');
    await service.settled(shapeId);
    expect(notices()).toEqual(['Continued in a fresh session; nothing is lost']);
    await tick();
    expect(getShapeSdkSessionId(c.store.db, shapeId)).toBeNull();
    const old = must(adapter.shapeSessions[0], 'the first session');
    expect(getSession(c.store.db, old.spec.sessionId).endedAt).not.toBeNull();

    adapter.shapeBehaviour = () => Promise.resolve({ text: 'fresh', contextPercent: 5 });
    const b = service.send(shapeId, 'second thing');
    await service.settled(shapeId);
    const fresh = must(adapter.shapeSessions[1], 'a fresh session');
    expect(fresh.spec.resumeProviderSessionId).toBeNull();
    expect(fresh.spec.prompt).toContain('continues in a fresh session');
    expect(fresh.spec.prompt).toContain(`[m:${a.id}] first thing`);
    expect(fresh.spec.prompt).toContain(`[m:${b.id}] second thing`);
    expect(transcript().some((m) => m.kind === ShapeMessageKind.Digest)).toBe(true);
  });

  it('stays in the session at exactly 70%', async () => {
    adapter.shapeBehaviour = () => Promise.resolve({ text: 'ok', contextPercent: 70 });
    service.send(shapeId, 'one');
    await service.settled(shapeId);
    service.send(shapeId, 'two');
    await service.settled(shapeId);
    expect(adapter.shapeSessions).toHaveLength(1);
    expect(notices()).toEqual([]);
  });
});

describe('idle and resume', () => {
  it('closes the session after 10 idle minutes and resumes it on the next message', async () => {
    service.send(shapeId, 'one');
    await service.settled(shapeId);
    const first = must(adapter.shapeSessions[0], 'a session');
    clock.advance(9 * 60_000);
    await tick();
    expect(getSession(c.store.db, first.spec.sessionId).endedAt).toBeNull();
    clock.advance(60_000);
    await tick();
    expect(getSession(c.store.db, first.spec.sessionId)).toMatchObject({ exitReason: 'idle' });
    expect(getShapeSdkSessionId(c.store.db, shapeId)).toBe('fake-shape-1');

    service.send(shapeId, 'two');
    await service.settled(shapeId);
    const second = must(adapter.shapeSessions[1], 'a resumed session');
    expect(second.spec.resumeProviderSessionId).toBe('fake-shape-1');
    expect(second.spec.prompt).not.toContain('fresh session');
    expect(adapter.shapeSessions).toHaveLength(2);
  });

  it('starts no new session until the idle one has closed, and its end does not end the next turn', async () => {
    service.send(shapeId, 'one');
    await service.settled(shapeId);
    const first = must(adapter.shapeSessions[0], 'a session');
    const closing = gate();
    const hold = gate();
    // A failed assertion still lets afterEach close the sessions.
    onTestFinished(() => {
      closing.open();
      hold.open();
    });
    adapter.shapeStopGate = closing.wait;
    clock.advance(10 * 60_000);
    await tick();
    // The process is still closing when the builder comes back.
    expect(getSession(c.store.db, first.spec.sessionId).endedAt).toBeNull();
    adapter.shapeBehaviour = async () => {
      await hold.wait;
      return { text: 'two done' };
    };
    service.send(shapeId, 'two');
    let done = false;
    void service.settled(shapeId).then(() => {
      done = true;
    });
    await tick();
    expect(adapter.shapeSessions).toHaveLength(1);
    expect(service.propose(shapeId)).toEqual({ status: 'started' });
    expect(service.propose(shapeId)).toEqual({ status: 'ignored' });
    await expect(service.convert(shapeId, [mintId('ShapeProposal')])).rejects.toThrow(
      ConflictError,
    );

    closing.open();
    await tick();
    expect(getSession(c.store.db, first.spec.sessionId)).toMatchObject({ exitReason: 'idle' });
    const second = must(adapter.shapeSessions[1], 'a resumed session');
    expect(second.spec.resumeProviderSessionId).toBe('fake-shape-1');
    // The old session's end leaves the turn of the new one running.
    expect(done).toBe(false);
    expect(service.propose(shapeId)).toEqual({ status: 'ignored' });
    await expect(service.convert(shapeId, [mintId('ShapeProposal')])).rejects.toThrow(
      ConflictError,
    );
    expect(second.sent).toEqual([]);

    hold.open();
    await service.settled(shapeId);
    expect(done).toBe(true);
    expect(second.sent).toHaveLength(1);
    expect(adapter.shapeSessions).toHaveLength(2);
  });

  it('ends the running turn when the service closes', async () => {
    adapter.shapeBehaviour = () => new Promise(() => undefined);
    service.send(shapeId, 'one');
    await tick();
    await service.close();
    await service.settled(shapeId);
    const session = must(adapter.shapeSessions[0], 'a session');
    expect(getSession(c.store.db, session.spec.sessionId)).toMatchObject({ exitReason: 'stopped' });
  });

  it('does not close a session that has a turn running', async () => {
    const hold = gate();
    adapter.shapeBehaviour = async () => {
      await hold.wait;
      return { text: 'late' };
    };
    service.send(shapeId, 'one');
    await tick();
    clock.advance(30 * 60_000);
    await tick();
    const session = must(adapter.shapeSessions[0], 'a session');
    expect(getSession(c.store.db, session.spec.sessionId).endedAt).toBeNull();
    hold.open();
    await service.settled(shapeId);
  });
});

describe('a turn that fails', () => {
  it('notes it, and the next message goes to the same session', async () => {
    adapter.shapeBehaviour = () => Promise.reject(new Error('boom'));
    service.send(shapeId, 'one');
    await service.settled(shapeId);
    expect(notices()).toEqual(["Claude's turn failed; send the message again."]);
    adapter.shapeBehaviour = () => Promise.resolve({ text: 'back' });
    service.send(shapeId, 'two');
    await service.settled(shapeId);
    expect(
      transcript()
        .filter((m) => m.author === ShapeMessageAuthor.Claude && m.kind === ShapeMessageKind.Text)
        .map((m) => m.body),
    ).toContain('back');
    expect(adapter.shapeSessions).toHaveLength(1);
  });
});
