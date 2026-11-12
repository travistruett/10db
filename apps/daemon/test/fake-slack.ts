import { SlackError, type SlackClient, type SlackMessage, type SlackPostInput } from '../src/slack';

/** A Slack client that records what 10db posts and opens, and fails a method when told to. */
export class FakeSlack implements SlackClient {
  posts: (SlackPostInput & { ts: string })[] = [];
  opened: { kind: 'dm' | 'group'; users: string[] }[] = [];
  /** The next call to a method throws this Slack code. */
  failing = new Map<string, string[]>();
  /** What a read of a conversation answers. */
  found: SlackMessage[] = [];
  private counter = 0;

  failNext(method: string, code: string): void {
    this.failing.set(method, [...(this.failing.get(method) ?? []), code]);
  }
  private maybeFail(method: string): void {
    const code = this.failing.get(method)?.shift();
    if (code !== undefined) throw new SlackError(method, code);
  }
  authTest = () => Promise.reject(new Error('unused'));
  listMembers = () => Promise.reject(new Error('unused'));
  openDm(userId: string): Promise<string> {
    this.maybeFail('conversations.open');
    this.opened.push({ kind: 'dm', users: [userId] });
    return Promise.resolve(`D-${userId}`);
  }
  openGroup(userIds: readonly string[]): Promise<string> {
    this.maybeFail('conversations.open');
    this.opened.push({ kind: 'group', users: [...userIds] });
    return Promise.resolve(`G-${userIds.join('-')}`);
  }
  post(input: SlackPostInput): Promise<{ ts: string }> {
    this.maybeFail('chat.postMessage');
    this.counter += 1;
    const ts = `${String(1000 + this.counter)}.000100`;
    this.posts.push({ ...input, ts });
    return Promise.resolve({ ts });
  }
  permalink = (channel: string, ts: string) => Promise.resolve(`https://slack/${channel}/${ts}`);
  replies = () => Promise.resolve(this.found);
  history = () => Promise.resolve(this.found);
  reactions = () => Promise.resolve([]);
  addReaction = () => Promise.resolve();
  userInfo = () => Promise.resolve('x');
}
