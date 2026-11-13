import { describe, expect, it } from 'vitest';
import type { GithubLoginEndedData } from '@10db/contracts';
import { ManualClock } from '../clock';
import {
  CODE_WAIT_MS,
  createGithubLogin,
  KILL_GRACE_MS,
  SIGN_IN_WAIT_MS,
  type GhLoginChild,
  type GhLoginSpawn,
} from './login';

const CODE_LINE = '! First copy your one-time code: ABCD-1234\n';
const URL_LINE = 'Open this URL to continue in your web browser: https://github.com/login/device\n';
const SIGNED_IN = { code: 'ABCD-1234', url: 'https://github.com/login/device' };

class FakeChild implements GhLoginChild {
  readonly signals: NodeJS.Signals[] = [];
  private output: ((stream: 'stdout' | 'stderr', chunk: string) => void)[] = [];
  private exits: ((code: number | null) => void)[] = [];
  onOutput(listener: (stream: 'stdout' | 'stderr', chunk: string) => void): void {
    this.output.push(listener);
  }
  onExit(listener: (code: number | null) => void): void {
    this.exits.push(listener);
  }
  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
  }
  print(stream: 'stdout' | 'stderr', chunk: string): void {
    for (const l of this.output) l(stream, chunk);
  }
  exit(code: number | null): void {
    for (const l of this.exits) l(code);
  }
}

function setup(opts: { gh?: () => string | null; login?: () => Promise<string | null> } = {}) {
  const clock = new ManualClock();
  const children: FakeChild[] = [];
  const spawned: { gh: string; env: Readonly<Record<string, string>> }[] = [];
  const ended: GithubLoginEndedData[] = [];
  const reads: string[] = [];
  const spawn: GhLoginSpawn = (gh, env) => {
    const child = new FakeChild();
    children.push(child);
    spawned.push({ gh, env });
    return child;
  };
  const login = createGithubLogin({
    clock,
    spawn,
    resolveGh: opts.gh ?? (() => '/opt/homebrew/bin/gh'),
    env: () => ({ PATH: '/usr/bin' }),
    readLogin: () => {
      reads.push('read');
      return (opts.login ?? (() => Promise.resolve('octocat')))();
    },
    ended: (data) => {
      ended.push(data);
    },
  });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  return { clock, children, spawned, ended, reads, login, flush };
}

/** Starts a sign-in and prints the code so the slot is waiting. */
async function waiting(world: ReturnType<typeof setup>) {
  const post = world.login.start();
  const child = world.children[0];
  if (!child) throw new Error('nothing spawned');
  child.print('stderr', CODE_LINE + URL_LINE);
  await expect(post).resolves.toMatchObject(SIGNED_IN);
  return child;
}

describe('idle', () => {
  it('POST spawns gh with the login env and answers the code and page', async () => {
    const world = setup();
    const post = world.login.start();
    world.children[0]?.print('stderr', CODE_LINE + URL_LINE);
    await expect(post).resolves.toMatchObject(SIGNED_IN);
    expect(world.spawned).toEqual([{ gh: '/opt/homebrew/bin/gh', env: { PATH: '/usr/bin' } }]);
    expect(world.login.current()).toMatchObject(SIGNED_IN);
  });
  it('a gh that prints no code in 5 s is killed and the POST answers 502', async () => {
    const world = setup();
    const post = world.login.start();
    const refused = expect(post).rejects.toMatchObject({
      code: 'upstream',
      message: "gh didn't print a code",
    });
    world.clock.advance(CODE_WAIT_MS);
    await refused;
    expect(world.children[0]?.signals).toEqual(['SIGTERM']);
    expect(world.login.current()).toBeNull();
    // The slot is free again.
    void world.login.start();
    expect(world.children).toHaveLength(2);
  });
  it('a gh that is not installed refuses the POST with 409 and spawns nothing', async () => {
    const world = setup({ gh: () => null });
    const refused = await world.login.start().catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'conflict' });
    expect(refused instanceof Error ? refused.message : '').toContain("gh isn't installed");
    expect(world.children).toHaveLength(0);
  });
  it('resolves gh again on each start', async () => {
    let path: string | null = null;
    const world = setup({ gh: () => path });
    await expect(world.login.start()).rejects.toMatchObject({ code: 'conflict' });
    path = '/usr/local/bin/gh';
    const post = world.login.start();
    world.children[0]?.print('stdout', CODE_LINE + URL_LINE);
    await expect(post).resolves.toMatchObject(SIGNED_IN);
    expect(world.spawned[0]?.gh).toBe('/usr/local/bin/gh');
  });
  it('a gh that cannot be spawned answers 502', async () => {
    const world = setup();
    const login = createGithubLogin({
      clock: world.clock,
      spawn: () => {
        throw new Error('spawn EACCES');
      },
      resolveGh: () => '/x/gh',
      env: () => ({}),
      readLogin: () => Promise.resolve(null),
      ended: () => undefined,
    });
    await expect(login.start()).rejects.toMatchObject({ code: 'upstream' });
    // The failed spawn did not take the slot.
    await expect(login.start()).rejects.toMatchObject({ code: 'upstream' });
  });
  it('DELETE is a no-op', () => {
    const world = setup();
    world.login.cancel();
    expect(world.ended).toEqual([]);
  });
});

describe('starting (gh spawned, no code yet)', () => {
  it('a second POST is 409', async () => {
    const world = setup();
    void world.login.start().catch(() => undefined);
    await expect(world.login.start()).rejects.toMatchObject({ code: 'conflict' });
    expect(world.children).toHaveLength(1);
  });
  it.each([
    {
      name: 'the code and the page arrive in either order, split across chunks, on either stream',
      chunks: [
        ['stdout', 'Open this URL to continue in your web browser: https://github.com/lo'],
        ['stdout', 'gin/device\r\n'],
        ['stderr', '! First copy your one-time code: ABCD'],
        ['stderr', '-1234\r\n'],
      ] as const,
    },
  ])('$name', async ({ chunks }) => {
    const world = setup();
    const post = world.login.start();
    for (const [stream, chunk] of chunks) world.children[0]?.print(stream, chunk);
    await expect(post).resolves.toMatchObject(SIGNED_IN);
  });
  it('gh exiting 0 re-reads the login and the POST answers 409 "Already signed in"', async () => {
    const world = setup();
    const post = world.login.start();
    const refused = expect(post).rejects.toMatchObject({
      code: 'conflict',
      message: 'Already signed in',
    });
    world.children[0]?.exit(0);
    await refused;
    expect(world.reads).toHaveLength(1);
    expect(world.ended).toEqual([]);
    expect(world.login.current()).toBeNull();
  });
  it("gh exiting non-zero answers 502 with gh's last stderr line, mapped and bounded", async () => {
    const world = setup();
    const post = world.login.start();
    const refused = expect(post).rejects.toMatchObject({
      code: 'upstream',
      message: 'gh: something odd',
    });
    world.children[0]?.print('stderr', 'first\n\u001b[31mgh: something odd\u001b[0m\n');
    world.children[0]?.exit(1);
    await refused;
  });
  it('DELETE kills gh and the POST answers 409 "Cancelled"', async () => {
    const world = setup();
    const post = world.login.start();
    const refused = expect(post).rejects.toMatchObject({ code: 'conflict', message: 'Cancelled' });
    world.login.cancel();
    await refused;
    expect(world.children[0]?.signals).toEqual(['SIGTERM']);
    expect(world.ended).toEqual([]);
  });
  it('stop kills gh', async () => {
    const world = setup();
    const post = world.login.start();
    const refused = expect(post).rejects.toMatchObject({ code: 'conflict' });
    world.login.stop();
    await refused;
    expect(world.children[0]?.signals).toEqual(['SIGTERM']);
  });
});

describe('waiting (the code is shown, the builder approves in the browser)', () => {
  it('a second POST is 409', async () => {
    const world = setup();
    await waiting(world);
    await expect(world.login.start()).rejects.toMatchObject({ code: 'conflict' });
    expect(world.children).toHaveLength(1);
  });
  it('gh exiting 0 ends ok with the login re-read, and the slot is free', async () => {
    const world = setup();
    const child = await waiting(world);
    child.exit(0);
    await world.flush();
    expect(world.ended).toEqual([{ ok: true, login: 'octocat', message: null, cancelled: false }]);
    expect(world.login.current()).toBeNull();
    void world.login.start();
    expect(world.children).toHaveLength(2);
  });
  it('the login is read before the end is announced', async () => {
    const order: string[] = [];
    const world = setup({
      login: () => {
        order.push('read');
        return Promise.resolve('octocat');
      },
    });
    const child = await waiting(world);
    const original = world.ended.push.bind(world.ended);
    world.ended.push = (...items) => {
      order.push('ended');
      return original(...items);
    };
    child.exit(0);
    await world.flush();
    expect(order).toEqual(['read', 'ended']);
  });
  it('a login that cannot be read still ends ok, with no login', async () => {
    const world = setup({ login: () => Promise.reject(new Error('offline')) });
    const child = await waiting(world);
    child.exit(0);
    await world.flush();
    expect(world.ended).toEqual([{ ok: true, login: null, message: null, cancelled: false }]);
  });
  it("gh exiting non-zero ends not ok with gh's last stderr line", async () => {
    const world = setup();
    const child = await waiting(world);
    child.print('stderr', 'X Authentication failed: expired_token\n');
    child.exit(1);
    await world.flush();
    expect(world.ended).toEqual([
      {
        ok: false,
        login: null,
        message: 'The code expired. Press Sign In to get a new one.',
        cancelled: false,
      },
    ]);
    expect(world.reads).toEqual([]);
  });
  it('DELETE kills gh, ends cancelled and frees the slot; gh exiting later changes nothing', async () => {
    const world = setup();
    const child = await waiting(world);
    world.login.cancel();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(world.ended).toEqual([
      { ok: false, login: null, message: 'Sign-in cancelled.', cancelled: true },
    ]);
    child.exit(null);
    await world.flush();
    expect(world.ended).toHaveLength(1);
    expect(world.login.current()).toBeNull();
  });
  it('ten minutes kill gh and end not ok "Sign-in timed out"', async () => {
    const world = setup();
    const child = await waiting(world);
    world.clock.advance(SIGN_IN_WAIT_MS);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(world.ended).toEqual([
      { ok: false, login: null, message: 'Sign-in timed out', cancelled: false },
    ]);
  });
  it('a gh that outlives SIGTERM is sent SIGKILL after the grace', async () => {
    const world = setup();
    const child = await waiting(world);
    world.login.cancel();
    world.clock.advance(KILL_GRACE_MS);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
  it('a gh that exits within the grace is not killed again', async () => {
    const world = setup();
    const child = await waiting(world);
    world.login.cancel();
    child.exit(143);
    world.clock.advance(KILL_GRACE_MS);
    expect(child.signals).toEqual(['SIGTERM']);
  });
  it('stop kills gh and announces nothing', async () => {
    const world = setup();
    const child = await waiting(world);
    world.login.stop();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(world.ended).toEqual([]);
    expect(world.clock.pendingTimers()).toBe(1);
  });
  it('the 10 minutes run from the code, and the 5 s timer is gone once the code arrived', async () => {
    const world = setup();
    await waiting(world);
    world.clock.advance(CODE_WAIT_MS + 1);
    expect(world.ended).toEqual([]);
  });
});
