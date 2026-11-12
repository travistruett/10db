import {
  compareTs,
  SlackError,
  type SlackClient,
  type SlackMessage,
  type SlackPostInput,
} from '../src/slack';

export const FAKE_BOT_USER = 'UBOT';

/**
 * A Slack client that keeps the messages of every conversation, records what 10db posts and opens, and
 * fails a method when told to. A person typing is `say`; reads answer what was posted and said.
 */
export class FakeSlack implements SlackClient {
  posts: (SlackPostInput & { ts: string })[] = [];
  opened: { kind: 'dm' | 'group'; users: string[] }[] = [];
  /** The next call to a method throws this Slack code. */
  failing = new Map<string, string[]>();
  /** Messages a read also answers, besides what was posted and said. */
  found: SlackMessage[] = [];
  /** Every call made, by method, so a test can see that none was made. */
  calls: string[] = [];
  private messages = new Map<string, SlackMessage[]>();
  private reactionsOn = new Map<string, { name: string; users: string[] }[]>();
  private counter = 0;

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
  private enter(method: string): void {
    this.calls.push(method);
    const code = this.failing.get(method)?.shift();
    if (code !== undefined) throw new SlackError(method, code);
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

  authTest = () => {
    this.enter('auth.test');
    return Promise.resolve({ teamId: 'T1', teamName: 'Team', botUserId: FAKE_BOT_USER });
  };
  listMembers: SlackClient['listMembers'] = () => Promise.reject(new Error('unused'));
  openDm(userId: string): Promise<string> {
    this.enter('conversations.open');
    this.opened.push({ kind: 'dm', users: [userId] });
    return Promise.resolve(`D-${userId}`);
  }
  openGroup(userIds: readonly string[]): Promise<string> {
    this.enter('conversations.open');
    this.opened.push({ kind: 'group', users: [...userIds] });
    return Promise.resolve(`G-${userIds.join('-')}`);
  }
  post(input: SlackPostInput): Promise<{ ts: string }> {
    this.enter('chat.postMessage');
    const ts = this.nextTs();
    this.posts.push({ ...input, ts });
    const list = this.messages.get(input.channel) ?? [];
    list.push({
      ts,
      threadTs: input.threadTs ?? null,
      user: FAKE_BOT_USER,
      botId: 'B1',
      subtype: null,
      text: input.text,
      edited: false,
      reactions: [],
      metadata: input.metadata
        ? { eventType: input.metadata.eventType, eventPayload: input.metadata.eventPayload }
        : null,
    });
    this.messages.set(input.channel, list);
    return Promise.resolve({ ts });
  }
  permalink = (channel: string, ts: string) => Promise.resolve(`https://slack/${channel}/${ts}`);
  replies(channel: string, threadTs: string, oldest: string): Promise<SlackMessage[]> {
    this.enter('conversations.replies');
    const mine = (this.messages.get(channel) ?? []).filter(
      (m) => (m.ts === threadTs || m.threadTs === threadTs) && compareTs(m.ts, oldest) >= 0,
    );
    return Promise.resolve([...this.found, ...mine].sort((a, b) => compareTs(a.ts, b.ts)));
  }
  history(channel: string, oldest: string): Promise<SlackMessage[]> {
    this.enter('conversations.history');
    const mine = (this.messages.get(channel) ?? []).filter(
      (m) => (m.threadTs === null || m.threadTs === m.ts) && compareTs(m.ts, oldest) > 0,
    );
    return Promise.resolve([...this.found, ...mine].sort((a, b) => compareTs(a.ts, b.ts)));
  }
  reactions(channel: string, ts: string) {
    this.enter('reactions.get');
    return Promise.resolve(this.reactionsOn.get(`${channel}/${ts}`) ?? []);
  }
  addReaction = () => {
    this.enter('reactions.add');
    return Promise.resolve();
  };
  userInfo = () => {
    this.enter('users.info');
    return Promise.resolve('x');
  };
}
