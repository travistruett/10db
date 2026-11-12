import { ManualClock } from '../src/clock';
import {
  compareTs,
  createSlackClient,
  type SlackClient,
  type SlackMessage,
  type SlackPostInput,
} from '../src/slack';

export const FAKE_BOT_USER = 'UBOT';
/** How long the real client waits for a fake answer on the fake's own clock. */
const CALL_TIMEOUT_MS = 1000;

type Body = Record<string, unknown>;

/**
 * Slack's Web API as a `fetch`, behind the real `createSlackClient`: the fake keeps the messages of every
 * conversation, answers in Slack's own shapes, and fails a method when told to. A person typing is `say`;
 * what 10db posted and opened is read back from `posts` and `opened`.
 */
export class FakeSlack implements SlackClient {
  posts: (SlackPostInput & { ts: string })[] = [];
  opened: { kind: 'dm' | 'group'; users: string[] }[] = [];
  /** Messages every read also answers, besides what was posted and said. */
  found: SlackMessage[] = [];
  /** Every HTTP call made, by Slack method, so a test can see that none was made. */
  calls: string[] = [];
  /** The next call to a method fails with this code, as Slack or the network would fail it. */
  private failing = new Map<string, string[]>();
  private messages = new Map<string, SlackMessage[]>();
  private reactionsOn = new Map<string, { name: string; users: string[] }[]>();
  private pauses = new Map<string, Promise<void>>();
  private counter = 0;
  private current = '';
  private readonly clock = new ManualClock();
  private readonly real: SlackClient;

  constructor() {
    this.real = createSlackClient({
      fetch: (url, init) => this.handle(url, init),
      token: () => Promise.resolve(this.tokenFor()),
      clock: this.clock,
      timeoutMs: CALL_TIMEOUT_MS,
    });
  }

  failNext(method: string, code: string): void {
    this.failing.set(method, [...(this.failing.get(method) ?? []), code]);
  }
  /** Every call to the method fails with the code until `clearFailing`. */
  failAlways(method: string, code: string): void {
    this.failing.set(
      method,
      Array.from({ length: 1000 }, () => code),
    );
  }
  clearFailing(): void {
    this.failing.clear();
  }
  /** The next call to `method` waits until the returned function is called. */
  pause(method: string): () => void {
    let release: () => void = () => undefined;
    this.pauses.set(
      method,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }

  private nextTs(): string {
    this.counter += 1;
    return `${String(1000 + this.counter)}.000100`;
  }

  /** A person types `text` in a conversation: in a thread, or at the top level with `threadTs: null`. */
  say(channel: string, who: string, text: string, threadTs: string | null = null): string {
    const ts = this.nextTs();
    const list = this.messages.get(channel) ?? [];
    list.push({
      ts,
      threadTs,
      user: who,
      botId: null,
      subtype: null,
      text,
      edited: false,
      reactions: [],
      metadata: null,
    });
    this.messages.set(channel, list);
    return ts;
  }

  /** A person puts a reaction on a message. */
  react(channel: string, ts: string, name: string, who: string): void {
    const key = `${channel}/${ts}`;
    const list = this.reactionsOn.get(key) ?? [];
    const found = list.find((r) => r.name === name);
    if (found) found.users.push(who);
    else list.push({ name, users: [who] });
    this.reactionsOn.set(key, list);
  }

  /** What 10db posted to a channel, oldest first. */
  textsIn(channel: string): string[] {
    return this.posts.filter((p) => p.channel === channel).map((p) => p.text);
  }

  // The SlackClient surface: each call goes through the real client and the fake `fetch` below.
  private run<T>(method: string, call: () => Promise<T>): Promise<T> {
    this.current = method;
    return call();
  }
  authTest: SlackClient['authTest'] = () => this.run('auth.test', () => this.real.authTest());
  listMembers: SlackClient['listMembers'] = (cursor) =>
    this.run('users.list', () => this.real.listMembers(cursor));
  openDm: SlackClient['openDm'] = (userId) =>
    this.run('conversations.open', () => this.real.openDm(userId));
  openGroup: SlackClient['openGroup'] = (userIds) =>
    this.run('conversations.open', () => this.real.openGroup(userIds));
  post: SlackClient['post'] = (input) => this.run('chat.postMessage', () => this.real.post(input));
  permalink: SlackClient['permalink'] = (channel, ts) =>
    this.run('chat.getPermalink', () => this.real.permalink(channel, ts));
  replies: SlackClient['replies'] = (channel, threadTs, oldest) =>
    this.run('conversations.replies', () => this.real.replies(channel, threadTs, oldest));
  history: SlackClient['history'] = (channel, oldest) =>
    this.run('conversations.history', () => this.real.history(channel, oldest));
  reactions: SlackClient['reactions'] = (channel, ts) =>
    this.run('reactions.get', () => this.real.reactions(channel, ts));
  addReaction: SlackClient['addReaction'] = (channel, ts, name) =>
    this.run('reactions.add', () => this.real.addReaction(channel, ts, name));
  userInfo: SlackClient['userInfo'] = (userId) =>
    this.run('users.info', () => this.real.userInfo(userId));

  /** The token, unless the method about to be called was told to fail as if none were stored. */
  private tokenFor(): string | null {
    const queue = this.failing.get(this.current);
    if (queue?.[0] === 'no_token') {
      queue.shift();
      return null;
    }
    return 'xoxb-fake-token';
  }

  private json(body: Body, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  private raw(m: SlackMessage): Body {
    return {
      ts: m.ts,
      ...(m.threadTs === null ? {} : { thread_ts: m.threadTs }),
      ...(m.user === null ? {} : { user: m.user }),
      ...(m.botId === null ? {} : { bot_id: m.botId }),
      ...(m.subtype === null ? {} : { subtype: m.subtype }),
      text: m.text,
      ...(m.edited ? { edited: { user: m.user ?? '', ts: m.ts } } : {}),
      reactions: m.reactions.map((r) => ({ name: r.name, users: [...r.users] })),
      ...(m.metadata
        ? { metadata: { event_type: m.metadata.eventType, event_payload: m.metadata.eventPayload } }
        : {}),
    };
  }

  /** The `fetch` the real client talks to. */
  private async handle(input: URL | string | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = url.pathname.split('/').at(-1) ?? '';
    this.calls.push(method);
    const code = this.failing.get(method)?.shift();
    if (code === 'unreachable') throw new Error('network is down');
    if (code === 'timeout') {
      // Nothing answers; the real client's own timer fires once the fake clock moves past it.
      queueMicrotask(() => {
        this.clock.advance(CALL_TIMEOUT_MS);
      });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    }
    if (code === 'ratelimited') return this.json({}, 429, { 'Retry-After': '30' });
    if (code === 'bad_reply') return new Response('not json', { status: 200 });
    const http = code === undefined ? null : /^http_(\d{3})$/.exec(code);
    if (http) return this.json({}, Number(http[1]));
    if (code !== undefined) return this.json({ ok: false, error: code });
    const paused = this.pauses.get(method);
    this.pauses.delete(method);
    if (paused) await paused;
    const body: Body =
      typeof init?.body === 'string' && init.body !== '' ? (JSON.parse(init.body) as Body) : {};
    const query = (name: string): string => url.searchParams.get(name) ?? '';
    switch (method) {
      case 'auth.test':
        return this.json({ ok: true, team_id: 'T1', team: 'Team', user_id: FAKE_BOT_USER });
      case 'users.list':
        return this.json({ ok: true, members: [], response_metadata: { next_cursor: '' } });
      case 'conversations.open': {
        const users = (typeof body['users'] === 'string' ? body['users'] : '').split(',');
        this.opened.push({ kind: users.length === 1 ? 'dm' : 'group', users });
        return this.json({
          ok: true,
          channel: { id: users.length === 1 ? `D-${users[0] ?? ''}` : `G-${users.join('-')}` },
        });
      }
      case 'chat.postMessage': {
        const ts = this.nextTs();
        const channel = typeof body['channel'] === 'string' ? body['channel'] : '';
        const meta = body['metadata'] as
          | { event_type: string; event_payload: Record<string, string | number | boolean> }
          | undefined;
        const threadTs = typeof body['thread_ts'] === 'string' ? body['thread_ts'] : undefined;
        this.posts.push({
          channel,
          text: typeof body['text'] === 'string' ? body['text'] : '',
          blocks: [],
          ...(threadTs === undefined ? {} : { threadTs }),
          ...(meta
            ? { metadata: { eventType: meta.event_type, eventPayload: meta.event_payload } }
            : {}),
          ts,
        });
        const list = this.messages.get(channel) ?? [];
        list.push({
          ts,
          threadTs: threadTs ?? null,
          user: FAKE_BOT_USER,
          botId: 'B1',
          subtype: null,
          text: typeof body['text'] === 'string' ? body['text'] : '',
          edited: false,
          reactions: [],
          metadata: meta ? { eventType: meta.event_type, eventPayload: meta.event_payload } : null,
        });
        this.messages.set(channel, list);
        return this.json({ ok: true, ts });
      }
      case 'chat.getPermalink':
        return this.json({
          ok: true,
          permalink: `https://slack/${query('channel')}/${query('message_ts')}`,
        });
      case 'conversations.replies': {
        const channel = query('channel');
        const thread = query('ts');
        const oldest = query('oldest');
        const mine = (this.messages.get(channel) ?? []).filter(
          (m) => (m.ts === thread || m.threadTs === thread) && compareTs(m.ts, oldest) >= 0,
        );
        return this.json({ ok: true, messages: this.sorted([...this.found, ...mine]) });
      }
      case 'conversations.history': {
        const mine = (this.messages.get(query('channel')) ?? []).filter(
          (m) =>
            (m.threadTs === null || m.threadTs === m.ts) && compareTs(m.ts, query('oldest')) > 0,
        );
        return this.json({ ok: true, messages: this.sorted([...this.found, ...mine]) });
      }
      case 'reactions.get':
        return this.json({
          ok: true,
          message: {
            reactions: this.reactionsOn.get(`${query('channel')}/${query('timestamp')}`) ?? [],
          },
        });
      case 'reactions.add':
        return this.json({ ok: true });
      case 'users.info':
        return this.json({ ok: true, user: { name: 'x' } });
      default:
        return this.json({ ok: false, error: 'unknown_method' });
    }
  }

  private sorted(list: SlackMessage[]): Body[] {
    return list.sort((a, b) => compareTs(a.ts, b.ts)).map((m) => this.raw(m));
  }
}
