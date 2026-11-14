import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../clock';
import { createSlackClient, SlackError, slackRefusedToken, type SlackClient } from './index';

// A made-up token, built in two parts so the secret scanner does not mistake it for a real one.
const TOKEN = ['xox', 'b-1111111111-2222222222-secretsecretsecret'].join('');

interface Call {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

interface Reply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body: unknown;
}

function fakeSlack(replies: readonly Reply[] | ((call: Call) => Reply)) {
  const calls: Call[] = [];
  const fetchFake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: Call = {
      url: new URL(raw),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = typeof replies === 'function' ? replies(call) : replies[calls.length - 1];
    if (reply === undefined) throw new Error('no reply scripted');
    return Promise.resolve(
      new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: reply.headers ?? {},
      }),
    );
  };
  return { calls, fetch: fetchFake };
}

function clientWith(
  fetchFake: typeof fetch,
  token: string | null = TOKEN,
  clock = new ManualClock(),
) {
  return createSlackClient({
    fetch: fetchFake,
    token: () => Promise.resolve(token),
    clock,
    timeoutMs: 10_000,
  });
}

const ok = (body: Record<string, unknown>): Reply => ({ body: { ok: true, ...body } });

describe('request shapes', () => {
  it('auth.test is a bearer POST with no body', async () => {
    const slack = fakeSlack([ok({ team_id: 'T1', team: 'Acme', user_id: 'UBOT' })]);
    const who = await clientWith(slack.fetch).authTest();
    expect(who).toEqual({ teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT' });
    expect(slack.calls[0]?.url.href).toBe('https://slack.com/api/auth.test');
    expect(slack.calls[0]?.method).toBe('POST');
    expect(slack.calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('conversations.open sends one user for a DM and returns the channel id as given', async () => {
    const slack = fakeSlack([ok({ channel: { id: 'D123' } })]);
    expect(await clientWith(slack.fetch).openDm('U1')).toBe('D123');
    expect(slack.calls[0]?.url.pathname).toBe('/api/conversations.open');
    expect(slack.calls[0]?.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(slack.calls[0]?.body).toEqual({ users: 'U1' });
  });

  it('a group DM joins the users with commas and keeps a channel id that starts with C', async () => {
    const slack = fakeSlack([ok({ channel: { id: 'C0GROUP' } })]);
    expect(await clientWith(slack.fetch).openGroup(['U1', 'U2', 'U3'])).toBe('C0GROUP');
    expect(slack.calls[0]?.body).toEqual({ users: 'U1,U2,U3' });
  });

  it.each([
    ['one user', ['U1']],
    ['nine users', Array.from({ length: 9 }, (_, i) => `U${String(i)}`)],
  ])('refuses a group DM of %s before any request', async (_name, users) => {
    const slack = fakeSlack([]);
    await expect(clientWith(slack.fetch).openGroup(users)).rejects.toMatchObject({
      name: 'SlackError',
      code: 'invalid_arguments',
    });
    expect(slack.calls).toEqual([]);
  });

  it('posts with both unfurl flags off, the thread and the metadata', async () => {
    const slack = fakeSlack([ok({ ts: '1731300000.000100' })]);
    const posted = await clientWith(slack.fetch).post({
      channel: 'D1',
      text: 'hi',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hi', verbatim: true } }],
      threadTs: '1731300000.000050',
      metadata: { eventType: 'tendb_send', eventPayload: { send: 'snd_1' } },
    });
    expect(posted).toEqual({ ts: '1731300000.000100' });
    expect(slack.calls[0]?.url.pathname).toBe('/api/chat.postMessage');
    expect(slack.calls[0]?.body).toEqual({
      channel: 'D1',
      text: 'hi',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hi', verbatim: true } }],
      thread_ts: '1731300000.000050',
      metadata: { event_type: 'tendb_send', event_payload: { send: 'snd_1' } },
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it('a post without a thread or metadata sends neither, and still sends both unfurl flags off', async () => {
    const slack = fakeSlack([ok({ ts: '1.000001' })]);
    await clientWith(slack.fetch).post({ channel: 'D1', text: 'hi', blocks: [] });
    expect(slack.calls[0]?.body).toEqual({
      channel: 'D1',
      text: 'hi',
      blocks: [],
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it('reads a permalink', async () => {
    const slack = fakeSlack([ok({ permalink: 'https://acme.slack.com/archives/D1/p1' })]);
    expect(await clientWith(slack.fetch).permalink('D1', '1731300000.000100')).toBe(
      'https://acme.slack.com/archives/D1/p1',
    );
    expect(slack.calls[0]?.method).toBe('GET');
    expect(slack.calls[0]?.url.pathname).toBe('/api/chat.getPermalink');
    expect(Object.fromEntries(slack.calls[0]?.url.searchParams ?? [])).toEqual({
      channel: 'D1',
      message_ts: '1731300000.000100',
    });
  });

  it('adds a reaction by name', async () => {
    const slack = fakeSlack([ok({})]);
    await clientWith(slack.fetch).addReaction('D1', '1.000001', 'white_check_mark');
    expect(slack.calls[0]?.url.pathname).toBe('/api/reactions.add');
    expect(slack.calls[0]?.body).toEqual({
      channel: 'D1',
      timestamp: '1.000001',
      name: 'white_check_mark',
    });
  });

  it('reads a user name, preferring the display name', async () => {
    const slack = fakeSlack([
      ok({
        user: {
          id: 'U9',
          name: 'priya',
          real_name: 'Priya Rao',
          profile: { display_name: 'Priya' },
        },
      }),
    ]);
    expect(await clientWith(slack.fetch).userInfo('U9')).toBe('Priya');
    expect(slack.calls[0]?.url.pathname).toBe('/api/users.info');
    expect(slack.calls[0]?.url.searchParams.get('user')).toBe('U9');
  });
});

describe('reading a conversation', () => {
  // Shapes copied from the builder's live check: a thread reply carries `user`, `ts` and `thread_ts`, a
  // top-level message none, and the parent carries the reactions array.
  const threadBody = {
    messages: [
      {
        type: 'message',
        user: 'UBOT',
        text: 'Q',
        ts: '1731300000.000100',
        thread_ts: '1731300000.000100',
        reactions: [{ name: 'white_check_mark', users: ['UBOT', 'U1'], count: 2 }],
      },
      {
        type: 'message',
        user: 'U1',
        text: 'B',
        ts: '1731300050.000200',
        thread_ts: '1731300000.000100',
      },
    ],
    has_more: false,
  };

  it('reads replies with the oldest bound and metadata, keeping reactions', async () => {
    const slack = fakeSlack([ok(threadBody)]);
    const messages = await clientWith(slack.fetch).replies(
      'D1',
      '1731300000.000100',
      '1731300000.000100',
    );
    expect(Object.fromEntries(slack.calls[0]?.url.searchParams ?? [])).toMatchObject({
      channel: 'D1',
      ts: '1731300000.000100',
      oldest: '1731300000.000100',
      include_all_metadata: 'true',
    });
    expect(slack.calls[0]?.url.pathname).toBe('/api/conversations.replies');
    expect(messages.map((m) => [m.ts, m.user, m.threadTs, m.text])).toEqual([
      ['1731300000.000100', 'UBOT', '1731300000.000100', 'Q'],
      ['1731300050.000200', 'U1', '1731300000.000100', 'B'],
    ]);
    expect(messages[0]?.reactions).toEqual([{ name: 'white_check_mark', users: ['UBOT', 'U1'] }]);
    expect(messages[1]?.reactions).toEqual([]);
  });

  it('reads history oldest first, with top-level messages having no thread', async () => {
    const slack = fakeSlack([
      ok({
        messages: [
          { type: 'message', user: 'U1', text: 'later', ts: '1731300090.000100' },
          {
            type: 'message',
            bot_id: 'B1',
            subtype: 'bot_message',
            text: 'Q',
            ts: '1731300000.000100',
            metadata: { event_type: 'tendb_send', event_payload: { send: 'snd_1' } },
          },
        ],
      }),
    ]);
    const messages = await clientWith(slack.fetch).history('D1', '1731300000.000100');
    expect(slack.calls[0]?.url.pathname).toBe('/api/conversations.history');
    expect(slack.calls[0]?.url.searchParams.get('include_all_metadata')).toBe('true');
    expect(messages.map((m) => m.ts)).toEqual(['1731300000.000100', '1731300090.000100']);
    expect(messages[0]).toMatchObject({
      botId: 'B1',
      user: null,
      threadTs: null,
      subtype: 'bot_message',
      metadata: { eventType: 'tendb_send', eventPayload: { send: 'snd_1' } },
    });
  });

  it('follows the cursor until the last page', async () => {
    const slack = fakeSlack([
      ok({
        messages: [{ type: 'message', user: 'U1', text: 'a', ts: '1.000001' }],
        has_more: true,
        response_metadata: { next_cursor: 'c2' },
      }),
      ok({
        messages: [{ type: 'message', user: 'U1', text: 'b', ts: '2.000001' }],
        has_more: false,
      }),
    ]);
    const messages = await clientWith(slack.fetch).history('D1', '0');
    expect(messages.map((m) => m.text)).toEqual(['a', 'b']);
    expect(slack.calls[1]?.url.searchParams.get('cursor')).toBe('c2');
  });

  it('reads the reactions of one message', async () => {
    const slack = fakeSlack([
      ok({
        type: 'message',
        message: { reactions: [{ name: 'white_check_mark', users: ['UBOT', 'U1'], count: 2 }] },
      }),
    ]);
    expect(await clientWith(slack.fetch).reactions('D1', '1.000001')).toEqual([
      { name: 'white_check_mark', users: ['UBOT', 'U1'] },
    ]);
    expect(slack.calls[0]?.url.pathname).toBe('/api/reactions.get');
    expect(slack.calls[0]?.url.searchParams.get('timestamp')).toBe('1.000001');
  });

  it('a message with no reactions reads as an empty list', async () => {
    const slack = fakeSlack([ok({ message: { text: 'x' } })]);
    expect(await clientWith(slack.fetch).reactions('D1', '1.000001')).toEqual([]);
  });
});

describe('the member list', () => {
  const member = (over: Record<string, unknown>) => ({
    id: 'U1',
    team_id: 'T1',
    name: 'mark',
    deleted: false,
    is_bot: false,
    real_name: 'Mark Lee',
    profile: {
      title: 'PM',
      email: 'mark@acme.test',
      image_72: 'https://img.test/m.png',
      display_name: '',
    },
    ...over,
  });

  it('drops deleted users, bots, Slackbot and members of another team, and keeps a next cursor', async () => {
    const slack = fakeSlack([
      ok({ team_id: 'T1', team: 'Acme', user_id: 'UBOT' }),
      ok({
        members: [
          member({}),
          member({ id: 'U2', deleted: true }),
          member({ id: 'U3', is_bot: true }),
          member({ id: 'USLACKBOT', name: 'slackbot' }),
          member({ id: 'U5', team_id: 'T9' }),
          member({ id: 'U6', real_name: 'Ana Ruiz', profile: {} }),
        ],
        response_metadata: { next_cursor: 'next' },
      }),
    ]);
    const page = await clientWith(slack.fetch).listMembers('cur');
    expect(slack.calls[1]?.url.pathname).toBe('/api/users.list');
    expect(slack.calls[1]?.url.searchParams.get('cursor')).toBe('cur');
    expect(page.nextCursor).toBe('next');
    expect(page.members).toEqual([
      {
        userId: 'U1',
        teamId: 'T1',
        name: 'Mark Lee',
        realName: 'Mark Lee',
        title: 'PM',
        email: 'mark@acme.test',
        avatarUrl: 'https://img.test/m.png',
      },
      {
        userId: 'U6',
        teamId: 'T1',
        name: 'Ana Ruiz',
        realName: 'Ana Ruiz',
        title: null,
        email: null,
        avatarUrl: null,
      },
    ]);
  });
});

describe('failures', () => {
  it('ok:false becomes a SlackError with Slack code', async () => {
    const slack = fakeSlack([{ body: { ok: false, error: 'channel_not_found' } }]);
    const error = await clientWith(slack.fetch)
      .openDm('U1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlackError);
    expect(error).toMatchObject({ name: 'SlackError', code: 'channel_not_found' });
    expect((error as SlackError).message).toBe(
      'Slack conversations.open failed: channel_not_found',
    );
  });

  it('HTTP 429 with Retry-After gives retryAfterSeconds', async () => {
    const slack = fakeSlack([
      { status: 429, headers: { 'Retry-After': '30' }, body: { ok: false, error: 'ratelimited' } },
    ]);
    await expect(clientWith(slack.fetch).authTest()).rejects.toMatchObject({
      code: 'ratelimited',
      retryAfterSeconds: 30,
    });
  });

  it('another HTTP failure is http_<status>', async () => {
    const slack = fakeSlack([{ status: 503, body: 'upstream down' }]);
    await expect(clientWith(slack.fetch).authTest()).rejects.toMatchObject({ code: 'http_503' });
  });

  it.each([
    ['not JSON', { body: 'not json' }],
    ['no ok flag', { body: { team_id: 'T1' } }],
    ['a reply that fails its schema', { body: { ok: true, team_id: 7 } }],
  ])('%s is bad_reply', async (_name, reply) => {
    const slack = fakeSlack([reply]);
    await expect(clientWith(slack.fetch).authTest()).rejects.toMatchObject({ code: 'bad_reply' });
  });

  it('an error code that is not a plain word is bad_reply, never repeated', async () => {
    const slack = fakeSlack([{ body: { ok: false, error: 'oops <script> xoxb-1' } }]);
    await expect(clientWith(slack.fetch).authTest()).rejects.toMatchObject({ code: 'bad_reply' });
  });

  it('a fetch that throws is unreachable', async () => {
    const down = (() => Promise.reject(new Error(`connect refused with ${TOKEN}`))) as typeof fetch;
    await expect(clientWith(down).authTest()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('a fetch that never settles is a timeout once the clock passes timeoutMs', async () => {
    const clock = new ManualClock();
    const hung = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const result = clientWith(hung, TOKEN, clock)
      .authTest()
      .catch((e: unknown) => e);
    await vi.waitFor(() => {
      expect(clock.pendingTimers()).toBe(1);
    });
    clock.advance(9_999);
    clock.advance(1);
    expect(await result).toMatchObject({ name: 'SlackError', code: 'timeout' });
  });

  it('the timer is cancelled once a reply arrives', async () => {
    const clock = new ManualClock();
    const slack = fakeSlack([ok({ team_id: 'T', team: 'A', user_id: 'U' })]);
    await clientWith(slack.fetch, TOKEN, clock).authTest();
    expect(clock.pendingTimers()).toBe(0);
  });

  it.each([['an empty Keychain', null]])(
    '%s is no_token and nothing is sent',
    async (_name, token) => {
      const slack = fakeSlack([]);
      await expect(clientWith(slack.fetch, token).authTest()).rejects.toMatchObject({
        code: 'no_token',
      });
      expect(slack.calls).toEqual([]);
    },
  );
});

describe('the token never appears in an error', () => {
  const methods: readonly [string, (c: SlackClient) => Promise<unknown>][] = [
    ['authTest', (c) => c.authTest()],
    ['listMembers', (c) => c.listMembers()],
    ['openDm', (c) => c.openDm('U1')],
    ['openGroup', (c) => c.openGroup(['U1', 'U2'])],
    ['post', (c) => c.post({ channel: 'D1', text: 't', blocks: [] })],
    ['permalink', (c) => c.permalink('D1', '1.000001')],
    ['replies', (c) => c.replies('D1', '1.000001', '1.000001')],
    ['history', (c) => c.history('D1', '1.000001')],
    ['reactions', (c) => c.reactions('D1', '1.000001')],
    ['addReaction', (c) => c.addReaction('D1', '1.000001', 'white_check_mark')],
    ['userInfo', (c) => c.userInfo('U1')],
  ];

  it.each(methods)('%s: a refused call, an outage and a bad reply', async (_name, run) => {
    const failures: (typeof fetch)[] = [
      fakeSlack(() => ({ body: { ok: false, error: 'invalid_auth' } })).fetch,
      () => Promise.reject(new Error(`failed with Bearer ${TOKEN}`)),
      fakeSlack(() => ({ body: `garbage ${TOKEN}` })).fetch,
    ];
    for (const failing of failures) {
      const error = await run(clientWith(failing)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SlackError);
      const { message, stack } = error as SlackError;
      expect(message).not.toContain(TOKEN);
      expect(stack ?? '').not.toContain(TOKEN);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
  });
});

describe('slackRefusedToken', () => {
  it.each([
    ['invalid_auth', true],
    ['token_revoked', true],
    ['account_inactive', true],
    ['not_authed', true],
    ['channel_not_found', false],
    ['ratelimited', false],
    ['unreachable', false],
    ['no_token', false],
  ])('%s: %s', (code, refused) => {
    expect(slackRefusedToken(new SlackError('auth.test', code))).toBe(refused);
  });

  it('is false for anything that is not a SlackError', () => {
    expect(slackRefusedToken(new Error('invalid_auth'))).toBe(false);
  });
});
