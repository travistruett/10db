import {
  BUILDER_HANDLE,
  createTestStore,
  getInboxItem,
  getPerson,
  insertDraft,
  insertInboxItem,
  insertPerson,
  listPeople,
  markSending,
  markSent,
  seedProject,
  sendForCard,
  setDmChannel,
  setInboxRecipients,
  type Store,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { offJudge } from '../../test/engine';
import { createMemoryKeychain } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { slackBotAccount, LEGACY_SLACK_BOT_ACCOUNT } from '../environment';
import { createEventBus, createStateStore } from '../events';
import { silentLogger } from '../log';
import {
  cleanUpSlackSignIns,
  createReplyWatches,
  createSlackClients,
  createSlackConnections,
  createStakeholderSends,
  readSlackWorkspaces,
  saveSlackWorkspace,
} from '../stakeholders';
import { createStakeholderApiServices } from './stakeholder-services';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function world() {
  const clock = new ManualClock();
  const { store, close } = createTestStore(() => clock.now());
  closers.push(close);
  const state = createStateStore(store, createEventBus());
  const keychain = createMemoryKeychain();
  return { clock, state, store, keychain };
}

const withContact = (handle: string, teamId: string) => ({
  handle,
  name: handle,
  slack: [{ teamId, userId: `U-${handle}` }],
});

interface Bot {
  readonly teamId: string;
  readonly teamName: string;
  readonly botUserId: string;
}

/** A Slack that knows each token's bot and answers `invalid_auth` to any other; it records the tokens it saw. */
function fakeSlack(bots: Record<string, Bot>) {
  const tokens: string[] = [];
  const fetchSlack: typeof fetch = (_url, init) => {
    const header = new Headers(init?.headers).get('Authorization') ?? '';
    const token = header.replace('Bearer ', '');
    tokens.push(token);
    const bot = bots[token];
    return Promise.resolve(
      bot === undefined
        ? Response.json({ ok: false, error: 'invalid_auth' })
        : Response.json({
            ok: true,
            team_id: bot.teamId,
            team: bot.teamName,
            user_id: bot.botUserId,
            user: `bot-${bot.botUserId}`,
            url: 'https://x',
          }),
    );
  };
  return { fetch: fetchSlack, tokens };
}

function services(w: ReturnType<typeof world>, fetchSlack: typeof fetch) {
  const connections = createSlackConnections({ state: w.state, off: false });
  const watches = createReplyWatches({
    state: w.state,
    slack: null,
    inbox: {
      answerAs: () => {
        throw new Error('no reply is read here');
      },
    },
    judge: offJudge,
    sends: createStakeholderSends({
      state: w.state,
      slack: null,
      clock: w.clock,
      log: silentLogger,
      slackFor: () => null,
      boundTo: () => null,
    }),
    clock: w.clock,
    log: silentLogger,
    connections,
  });
  return createStakeholderApiServices({
    state: w.state,
    keychain: w.keychain,
    slack: null,
    sends: createStakeholderSends({
      state: w.state,
      slack: null,
      clock: w.clock,
      log: silentLogger,
      slackFor: () => null,
      boundTo: () => null,
    }),
    connections,
    clock: w.clock,
    fetch: fetchSlack,
    watches,
    draftOpts: { afterDraft: () => undefined, log: silentLogger },
    githubLogin: () => Promise.resolve(null),
    linear: { startImport: () => Promise.reject(new Error('not used')) },
    reporter: { setSettings: () => undefined },
  });
}

describe('Slack sign-ins by workspace', () => {
  it('stores the token under its team id and clears the old item and contacts of no signed-in workspace', async () => {
    const w = world();
    w.state.write((ctx) => {
      insertPerson(ctx, withContact('ana', 'T-OLD'));
      insertPerson(ctx, withContact('bo', 'T-NEW'));
    });
    w.keychain.write(LEGACY_SLACK_BOT_ACCOUNT, 'xoxb-old');
    const slack = fakeSlack({
      'xoxb-new': { teamId: 'T-NEW', teamName: 'Acme', botUserId: 'UBOT' },
    });
    await services(w, slack.fetch).setSlackToken({ token: 'xoxb-new' });

    expect(w.keychain.read(slackBotAccount('T-NEW'))).toBe('xoxb-new');
    expect(readSlackWorkspaces(w.state.db)).toMatchObject([
      { teamId: 'T-NEW', teamName: 'Acme', botUserId: 'UBOT', botName: 'bot-UBOT' },
    ]);

    cleanUpSlackSignIns({ state: w.state, keychain: w.keychain, log: silentLogger });

    expect(w.keychain.read(LEGACY_SLACK_BOT_ACCOUNT)).toBeNull();
    expect(w.keychain.read(slackBotAccount('T-NEW'))).toBe('xoxb-new');
    expect(listPeople(w.state.db).map((p) => [p.handle, p.slack.length > 0])).toEqual(
      expect.arrayContaining([
        ['bo', true],
        ['ana', false],
      ]),
    );
  });

  it('keeps every contact when there is no old token to clear, and tries again when the Keychain is unreadable', () => {
    const { state, keychain } = world();
    state.write((ctx) => {
      insertPerson(ctx, withContact('cy', 'T-GONE'));
    });
    // Disconnected (no workspaces) and no old item: nothing is deleted.
    cleanUpSlackSignIns({ state, keychain, log: silentLogger });
    expect(listPeople(state.db).every((p) => p.slack.length > 0)).toBe(true);

    // A Keychain that throws neither stops the start nor deletes anything.
    const locked = {
      ...keychain,
      read: () => {
        throw new Error('locked');
      },
    };
    expect(() => {
      cleanUpSlackSignIns({ state, keychain: locked, log: silentLogger });
    }).not.toThrow();
    expect(listPeople(state.db).every((p) => p.slack.length > 0)).toBe(true);
  });

  it('adds a second workspace beside the first and refuses a token for another team on a Replace', async () => {
    const w = world();
    const slack = fakeSlack({
      'xoxb-a': { teamId: 'T-A', teamName: 'Alpha', botUserId: 'UA' },
      'xoxb-b': { teamId: 'T-B', teamName: 'Beta', botUserId: 'UB' },
    });
    const api = services(w, slack.fetch);
    await api.setSlackToken({ token: 'xoxb-a' });
    await api.setSlackToken({ token: 'xoxb-b' });

    expect(w.keychain.read(slackBotAccount('T-A'))).toBe('xoxb-a');
    expect(w.keychain.read(slackBotAccount('T-B'))).toBe('xoxb-b');
    expect(readSlackWorkspaces(w.state.db).map((x) => x.teamId)).toEqual(['T-A', 'T-B']);

    const before = readSlackWorkspaces(w.state.db);
    await expect(api.setSlackToken({ token: 'xoxb-b', teamId: 'T-A' })).rejects.toThrow(
      'That token is for Beta. Use Add Workspace for it.',
    );
    expect(w.keychain.read(slackBotAccount('T-A'))).toBe('xoxb-a');
    expect(readSlackWorkspaces(w.state.db)).toEqual(before);
  });

  it('a token from a new bot clears that workspace only and returns its sent questions to the builder', async () => {
    const w = world();
    const slack = fakeSlack({
      'xoxb-a': { teamId: 'T-A', teamName: 'Alpha', botUserId: 'UA1' },
      'xoxb-a2': { teamId: 'T-A', teamName: 'Alpha', botUserId: 'UA2' },
      'xoxb-b': { teamId: 'T-B', teamName: 'Beta', botUserId: 'UB' },
    });
    const api = services(w, slack.fetch);
    await api.setSlackToken({ token: 'xoxb-a' });
    await api.setSlackToken({ token: 'xoxb-b' });

    const project = seedProject(w.store);
    const ana = w.state.write((ctx) =>
      insertPerson(ctx, {
        handle: 'ana',
        name: 'Ana',
        slack: [
          { teamId: 'T-A', userId: 'U-ana-a' },
          { teamId: 'T-B', userId: 'U-ana-b' },
        ],
      }),
    );
    w.state.write((ctx) => {
      setDmChannel(ctx, ana.id, 'T-A', 'D-A');
      setDmChannel(ctx, ana.id, 'T-B', 'D-B');
    });
    const sentIn = (teamId: string) =>
      sentQuestion(w.store, project.id, ana.id, teamId, `D-${teamId.slice(-1)}`);
    const cardA = sentIn('T-A');
    const cardB = sentIn('T-B');

    await api.setSlackToken({ token: 'xoxb-a2', teamId: 'T-A' });

    const contacts = getPerson(w.state.db, ana.id).slack;
    expect(contacts.find((c) => c.teamId === 'T-A')?.dmChannelId ?? null).toBeNull();
    expect(contacts.find((c) => c.teamId === 'T-B')?.dmChannelId).toBe('D-B');
    expect(sendForCard(w.state.db, cardA)).toMatchObject({ state: 'failed', error: 'bot_changed' });
    expect(getInboxItem(w.state.db, cardA).assignees).toEqual([BUILDER_HANDLE]);
    expect(sendForCard(w.state.db, cardB)).toMatchObject({ state: 'sent' });
    expect(getInboxItem(w.state.db, cardB).assignees).toEqual(['ana']);
    expect(readSlackWorkspaces(w.state.db).find((x) => x.teamId === 'T-A')).toMatchObject({
      botUserId: 'UA2',
    });
  });
});

describe('Reply watches by workspace', () => {
  it('reads each workspace with its own token, and one workspace refusing does not stop another', async () => {
    const w = world();
    const slack = fakeSlack({ 'xoxb-b': { teamId: 'T-B', teamName: 'Beta', botUserId: 'UB' } });
    w.state.write((ctx) => {
      saveSlackWorkspace(ctx, { teamId: 'T-A', teamName: 'Alpha' });
      saveSlackWorkspace(ctx, { teamId: 'T-B', teamName: 'Beta' });
    });
    w.keychain.write(slackBotAccount('T-A'), 'xoxb-revoked');
    w.keychain.write(slackBotAccount('T-B'), 'xoxb-b');
    const connections = createSlackConnections({ state: w.state, off: false });
    const watches = createReplyWatches({
      state: w.state,
      slack: createSlackClients({
        state: w.state,
        keychain: w.keychain,
        fetch: slack.fetch,
        clock: w.clock,
        timeoutMs: 5_000,
      }),
      inbox: {
        answerAs: () => {
          throw new Error('no reply is read while starting');
        },
      },
      judge: offJudge,
      sends: createStakeholderSends({
        state: w.state,
        slack: null,
        clock: w.clock,
        log: silentLogger,
        slackFor: () => null,
        boundTo: () => null,
      }),
      clock: w.clock,
      log: silentLogger,
      connections,
    });
    expect(connections.list().workspaces.map((x) => x.state)).toEqual(['checking', 'checking']);

    watches.start();
    // The clock never moves: only the check at start can find the states.
    await watches.stop();

    expect(connections.get('T-A')).toMatchObject({ state: 'refused', error: 'invalid_auth' });
    expect(connections.get('T-B')).toMatchObject({ state: 'connected', botUserId: 'UB' });
    expect([...slack.tokens].sort()).toEqual(['xoxb-b', 'xoxb-revoked']);
  });
});

/** A question a person was asked in a workspace, sent and waiting; its card is routed to that person. */
function sentQuestion(
  store: Store,
  projectId: Parameters<typeof insertInboxItem>[1]['projectId'],
  personId: Parameters<typeof insertDraft>[1]['recipients'][number],
  teamId: string,
  channelId: string,
) {
  return store.write((ctx) => {
    const card = insertInboxItem(ctx, {
      projectId,
      kind: 'question',
      title: `Which in ${teamId}?`,
      body: '',
      options: [],
      recommendation: null,
      category: 'design',
      urgency: 'normal',
      detail: null,
      foldKey: null,
      targets: [],
    });
    setInboxRecipients(ctx, card.id, { assignees: ['ana'], routedBy: 'rule', suggestion: null });
    const draft = insertDraft(ctx, {
      inboxItemId: card.id,
      teamId,
      recipients: [personId],
      text: 'Which?',
      hits: [],
    });
    markSending(ctx, draft.id, { textSha256: 'x', threadTs: null, startedAt: ctx.now });
    markSent(ctx, draft.id, {
      channelId,
      threadTs: '1.1',
      messageTs: '1.1',
      permalink: null,
      at: ctx.now,
    });
    return card.id;
  }).value;
}
