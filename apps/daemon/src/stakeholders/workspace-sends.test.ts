import { RoutedBy, type InboxItemId, type ProjectId, type SendFailure } from '@10db/contracts';
import {
  BUILDER_HANDLE,
  COPY_FOR_KEY,
  createTestStore,
  getInboxItem,
  insertDraft,
  insertInboxItem,
  insertPerson,
  insertTask,
  insertWorkstream,
  markSending,
  markSent,
  seedProject,
  sendForCard,
  setInboxRecipients,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryKeychain } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { slackBotAccount } from '../environment';
import { createEventBus, createStateStore } from '../events';
import { silentLogger } from '../log';
import { draftOnOpen, sweepDrafts } from './drafts';
import { rebindProjectSlack } from './project-binding';
import { recordBot } from './send-returns';
import { createStakeholderSends } from './sends';
import { createSlackClients } from './slack-clients';
import { boundTeam, projectSlack, saveSlackWorkspace, setProjectSlack } from './slack-workspaces';

const A = 'TA';
const B = 'TB';
const TOKENS: Record<string, string> = { [A]: 'xoxb-a', [B]: 'xoxb-b' };

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

interface Call {
  readonly method: string;
  readonly token: string;
  /** `users` of a conversations.open, `channel` of a post. */
  readonly users: string | null;
  readonly channel: string | null;
  readonly threadTs: string | null;
  readonly text: string | null;
}

/** The real stores, sends and clients over a fake Slack that records each call and can hold one post. */
function world() {
  const clock = new ManualClock();
  const { store, close } = createTestStore(() => clock.now());
  closers.push(close);
  const state = createStateStore(store, createEventBus());
  const keychain = createMemoryKeychain({
    [slackBotAccount(A)]: TOKENS[A] ?? '',
    [slackBotAccount(B)]: TOKENS[B] ?? '',
  });
  const calls: Call[] = [];
  let posts = 0;
  const hold: { reached: (() => void) | null; release: Promise<void> | null } = {
    reached: null,
    release: null,
  };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = url.pathname.split('/').pop() ?? '';
    const body: Record<string, unknown> =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    calls.push({
      method,
      token: (new Headers(init?.headers).get('Authorization') ?? '').replace('Bearer ', ''),
      users: str(body['users']),
      channel: str(body['channel']) ?? url.searchParams.get('channel'),
      threadTs: str(body['thread_ts']),
      text: str(body['text']),
    });
    if (method === 'conversations.open')
      return Response.json({ ok: true, channel: { id: `D-${str(body['users']) ?? ''}` } });
    if (method === 'chat.getPermalink')
      return Response.json({ ok: true, permalink: 'https://x/p' });
    if (method === 'chat.postMessage') {
      posts += 1;
      const ts = `${String(posts)}.000001`;
      if (hold.release !== null) {
        const release = hold.release;
        hold.release = null;
        hold.reached?.();
        await release;
      }
      return Response.json({ ok: true, ts });
    }
    return Response.json({ ok: false, error: 'unknown_method' });
  };
  const slack = createSlackClients({ state, keychain, fetch: fakeFetch, clock, timeoutMs: 5_000 });
  const sends = createStakeholderSends({
    state,
    slack,
    clock,
    log: silentLogger,
    slackFor: (id) => projectSlack(state.db, id).teamId,
    boundTo: (id) => boundTeam(state.db, id),
  });
  const pending: Promise<void>[] = [];
  const draftOpts = {
    afterDraft: (id: InboxItemId): void => {
      pending.push(sends.afterDraft(id));
    },
    log: silentLogger,
  };
  state.write((ctx) => {
    saveSlackWorkspace(ctx, { teamId: A, teamName: 'Alpha' });
    saveSlackWorkspace(ctx, { teamId: B, teamName: 'Beta' });
  });
  const project = (team: string | null): ProjectId => {
    const p = seedProject(store, { name: `p-${String(Math.random())}` });
    state.write((ctx) => {
      setProjectSlack(ctx, p.id, team);
    });
    return p.id;
  };
  const person = (
    handle: string,
    teams: readonly string[],
    limits: Readonly<Record<string, number>> = {},
    sendMode: 'auto' | 'review' = 'auto',
  ) =>
    state.write((ctx) =>
      insertPerson(ctx, {
        handle,
        name: handle,
        slack: teams.map((teamId) => ({
          teamId,
          userId: `U${teamId.slice(1)}-${handle}`,
          sendMode,
          dailyLimit: limits[teamId] ?? 10,
        })),
      }),
    );
  /** A routed question, drafted as the daemon drafts it after routing. */
  const ask = async (
    projectId: ProjectId,
    handles: string[],
    targets: { workstreamId: never; sessionId: null }[] = [],
  ) => {
    const after = state.write((ctx) => {
      const card = insertInboxItem(ctx, {
        projectId,
        kind: 'question',
        title: 'Charge tax?',
        body: '',
        options: [],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets,
      });
      const routed = setInboxRecipients(ctx, card.id, {
        assignees: handles,
        routedBy: RoutedBy.Rule,
        suggestion: null,
      });
      return { id: card.id, after: draftOnOpen(ctx, routed, draftOpts) };
    });
    after.after?.();
    await Promise.all(pending.splice(0));
    return after.id;
  };
  /** A question already sent to a person in a workspace, on a task if given. */
  const sentTo = (
    projectId: ProjectId,
    personId: Parameters<typeof insertDraft>[1]['recipients'][number],
    teamId: string,
    at: string,
    targets: { workstreamId: never; sessionId: null }[] = [],
  ) =>
    store.write((ctx) => {
      const card = insertInboxItem(ctx, {
        projectId,
        kind: 'question',
        title: 'Earlier',
        body: '',
        options: [],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets,
      });
      const draft = insertDraft(ctx, {
        inboxItemId: card.id,
        teamId,
        recipients: [personId],
        text: 'Earlier?',
        hits: [],
      });
      markSending(ctx, draft.id, { textSha256: 'x', threadTs: null, startedAt: at });
      markSent(ctx, draft.id, {
        channelId: 'D-OLD',
        threadTs: '9.9',
        messageTs: '9.9',
        permalink: null,
        at,
      });
      return card.id;
    }).value;
  const workstream = (projectId: ProjectId): { workstreamId: never; sessionId: null } =>
    store.write((ctx) => {
      const task = insertTask(ctx, projectId, {
        title: 'Tax',
        acceptanceCriteria: ['it works'],
        areas: ['api'],
      });
      const ws = insertWorkstream(ctx, task.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      // The id is a WorkstreamId; the helper's type only names the shape the card's targets take.
      return { workstreamId: ws.id as never, sessionId: null };
    }).value;
  const posted = (): Call[] => calls.filter((c) => c.method !== 'auth.test');
  return {
    clock,
    state,
    store,
    sends,
    draftOpts,
    calls: posted,
    hold,
    project,
    person,
    ask,
    sentTo,
    workstream,
  };
}

type World = ReturnType<typeof world>;
const sendState = (w: World, id: InboxItemId) => sendForCard(w.state.db, id);

describe('a question reaches only its project workspace', () => {
  it('posts with the project workspace token and the contact in it, in each workspace', async () => {
    const w = world();
    w.person('mark', [A, B], {}, 'review');
    const p1 = w.project(A);
    const p2 = w.project(B);
    const c1 = await w.ask(p1, ['mark']);
    const c2 = await w.ask(p2, ['mark']);
    expect(sendState(w, c1)).toMatchObject({ teamId: A });
    expect(sendState(w, c2)).toMatchObject({ teamId: B });

    await w.sends.send(c1, {});
    await w.sends.send(c2, {});

    const first = w.calls().filter((c) => c.token === 'xoxb-a');
    const second = w.calls().filter((c) => c.token === 'xoxb-b');
    expect(w.calls().length).toBe(first.length + second.length);
    expect(first.find((c) => c.method === 'conversations.open')?.users).toBe('UA-mark');
    expect(second.find((c) => c.method === 'conversations.open')?.users).toBe('UB-mark');
    expect(first.filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
    expect(second.filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
  });

  it('makes no draft and no call for a project with no workspace, or for a person with no contact in it', async () => {
    const w = world();
    w.person('mark', [A, B]);
    w.person('priya', [B]);
    const p3 = w.project(null);
    const p1 = w.project(A);
    const off = await w.ask(p3, ['mark']);
    const unreachable = await w.ask(p1, ['priya']);
    const mixed = await w.ask(p1, ['mark', 'priya']);

    for (const id of [off, unreachable, mixed]) {
      expect(sendState(w, id)).toBeNull();
      expect(getInboxItem(w.state.db, id).assignees).toEqual([BUILDER_HANDLE]);
    }
    expect(getInboxItem(w.state.db, off).detail?.[COPY_FOR_KEY]).toEqual(['mark']);
    expect(getInboxItem(w.state.db, unreachable).detail?.[COPY_FOR_KEY]).toEqual(['priya']);
    expect(getInboxItem(w.state.db, mixed).detail?.[COPY_FOR_KEY]).toEqual(['mark', 'priya']);
    expect(w.calls()).toEqual([]);
  });

  it('sends the first question to a person on Send on Its Own at once', async () => {
    const w = world();
    w.person('mark', [A]);

    const card = await w.ask(w.project(A), ['mark']);

    expect(sendState(w, card)).toMatchObject({ state: 'sent', heldBy: null });
  });

  it("counts a person's limit per workspace", async () => {
    const w = world();
    const mark = w.person('mark', [A, B], { [A]: 1, [B]: 1 });
    const p1 = w.project(A);
    const now = w.clock.now().toISOString();
    // Sent to in both: A long ago, B just now, so his limit of one is reached in B only.
    w.sentTo(p1, mark.id, A, '2020-01-01T00:00:00.000Z');
    w.sentTo(w.project(B), mark.id, B, now);

    const card = await w.ask(p1, ['mark']);

    expect(sendState(w, card)).toMatchObject({ state: 'sent', heldBy: null });
  });

  it("keeps an Off project's held draft through the start sweep", async () => {
    const w = world();
    w.person('ana', [A], {}, 'review');
    const p1 = w.project(A);
    const card = await w.ask(p1, ['ana']);
    expect(sendState(w, card)).toMatchObject({ state: 'draft', heldBy: 'review' });
    w.state.write((ctx) => {
      setProjectSlack(ctx, p1, null);
    });

    w.state.write((ctx) => sweepDrafts(ctx, w.draftOpts));

    expect(sendState(w, card)).toMatchObject({ state: 'draft', teamId: A });
    expect(getInboxItem(w.state.db, card).assignees).toEqual(['ana']);
  });

  it('takes back what is sent in the old workspace in the binding write, and posts a draft in the new one', async () => {
    const w = world();
    const mark = w.person('mark', [A, B]);
    w.person('ana', [A, B], {}, 'review');
    const p1 = w.project(A);
    const sent = w.sentTo(p1, mark.id, A, w.clock.now().toISOString());
    // Ana is on review, so her question waits as a draft.
    const draft = await w.ask(p1, ['ana']);
    expect(sendState(w, draft)).toMatchObject({ teamId: A });

    w.state
      .write((ctx) => rebindProjectSlack(ctx, p1, B, w.draftOpts))
      .forEach((step) => {
        step();
      });
    await Promise.resolve();

    expect(sendState(w, sent)).toMatchObject({
      state: 'failed',
      error: 'workspace_changed' satisfies SendFailure,
    });
    expect(getInboxItem(w.state.db, sent).assignees).toEqual([BUILDER_HANDLE]);
    expect(sendState(w, draft)).toMatchObject({ state: 'draft', teamId: B });
    expect(w.calls()).toEqual([]);

    await w.sends.send(draft, {});
    expect(w.calls().every((c) => c.token === 'xoxb-b')).toBe(true);
    expect(w.calls().find((c) => c.method === 'conversations.open')?.users).toBe('UB-ana');
  });

  it('keeps a post that lands after the move failed, and tells its thread in the old workspace', async () => {
    const w = world();
    w.person('mark', [A, B], {}, 'review');
    const p1 = w.project(A);
    const card = await w.ask(p1, ['mark']);
    const reached = new Promise<void>((resolve) => {
      w.hold.reached = resolve;
    });
    let release: () => void = () => undefined;
    w.hold.release = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = w.sends.send(card, {});
    await reached;
    const before = w.calls().length;

    w.state.write((ctx) => rebindProjectSlack(ctx, p1, B, w.draftOpts));
    release();
    await sending;

    expect(sendState(w, card)).toMatchObject({ state: 'failed', error: 'workspace_changed' });
    expect(getInboxItem(w.state.db, card).assignees).toEqual([BUILDER_HANDLE]);
    const later = w.calls().slice(before);
    expect(later.every((c) => c.token === 'xoxb-a')).toBe(true);
    const closing = later.filter((c) => c.method === 'chat.postMessage');
    expect(closing).toHaveLength(1);
    expect(closing[0]?.threadTs).toBe('1.000001');
  });

  it("does not join a thread from before the workspace's bot was recorded", async () => {
    const w = world();
    const mark = w.person('mark', [A]);
    const p1 = w.project(A);
    const target = w.workstream(p1);
    w.sentTo(p1, mark.id, A, '2020-01-01T00:00:00.000Z', [target]);
    w.state.write((ctx) => {
      recordBot(ctx, { teamId: A, teamName: 'Alpha', botUserId: 'UBOT', botName: 'bot' }, 'check');
    });

    // Mark was sent to before, so the question goes at once: into a new thread of his DM.
    await w.ask(p1, ['mark'], [target]);

    const post = w.calls().find((c) => c.method === 'chat.postMessage');
    expect(post).toMatchObject({ channel: 'D-UA-mark', threadTs: null });
  });
});
