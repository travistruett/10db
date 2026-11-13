import { describe, expect, it } from 'vitest';
import type { GithubLoginEndedData, GithubStatusDto } from '@10db/contracts';
import { ManualClock } from '../clock';
import { GhError, GhFailure, type GhLoginChild, type GhLoginSpawn } from '../github';
import { createGithubServices, STATUS_FRESH_MS } from './github-services';

class FakeChild implements GhLoginChild {
  readonly signals: NodeJS.Signals[] = [];
  private output: ((stream: 'stdout' | 'stderr', chunk: string) => void)[] = [];
  private exits: ((code: number | null) => void)[] = [];
  onOutput(l: (stream: 'stdout' | 'stderr', chunk: string) => void): void {
    this.output.push(l);
  }
  onExit(l: (code: number | null) => void): void {
    this.exits.push(l);
  }
  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
  }
  print(chunk: string): void {
    for (const l of this.output) l('stderr', chunk);
  }
  exit(code: number | null): void {
    for (const l of this.exits) l(code);
  }
}

type Answer = string | null | GhError;

function setup(initial: { gh: string | null; answer: Answer }) {
  const clock = new ManualClock();
  const world = {
    gh: initial.gh,
    answer: initial.answer,
    probes: 0,
    hold: null as Promise<void> | null,
    resolved: 0,
    children: [] as FakeChild[],
    events: [] as GithubLoginEndedData[],
    seenByEvent: [] as GithubStatusDto[],
  };
  const spawn: GhLoginSpawn = () => {
    const child = new FakeChild();
    world.children.push(child);
    return child;
  };
  const services = createGithubServices({
    clock,
    spawn,
    resolveGh: () => {
      world.resolved += 1;
      return world.gh;
    },
    readLogin: async () => {
      world.probes += 1;
      // What gh says is fixed when the call starts, as a real call that is already running is.
      const { gh, answer } = world;
      await world.hold;
      if (gh === null) throw new GhError(GhFailure.NotInstalled, 'gh is not installed');
      if (answer instanceof GhError) throw answer;
      return answer;
    },
    env: () => ({}),
    emit: (data) => {
      world.events.push(data);
      void services.githubStatus(false).then((dto) => world.seenByEvent.push(dto));
    },
  });
  return { clock, world, services };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('the GitHub status', () => {
  it.each([
    { name: 'signed in', gh: '/gh', answer: 'octocat', state: 'signed_in', login: 'octocat' },
    { name: 'signed out', gh: '/gh', answer: null, state: 'signed_out', login: null },
    { name: 'no gh', gh: null, answer: null, state: 'not_installed', login: null },
    {
      name: 'offline, never signed out',
      gh: '/gh',
      answer: new GhError(GhFailure.Unreachable, 'offline'),
      state: 'unreachable',
      login: null,
    },
    {
      name: 'a 401 gh reports as signed out',
      gh: '/gh',
      answer: new GhError(GhFailure.SignedOut, 'Bad credentials'),
      state: 'signed_out',
      login: null,
    },
    {
      name: 'any other gh failure leaves Sign In on offer',
      gh: '/gh',
      answer: new GhError(GhFailure.Failed, 'gh api user failed (exit 1)'),
      state: 'signed_out',
      login: null,
    },
    {
      name: 'a probe that timed out',
      gh: '/gh',
      answer: new GhError(GhFailure.Timeout, 'slow'),
      state: 'unreachable',
      login: null,
    },
  ])('reads $name', async ({ gh, answer, state, login }) => {
    const { services, clock } = setup({ gh, answer });
    await expect(services.githubStatus(false)).resolves.toEqual({
      state,
      login,
      checkedAt: clock.now().toISOString(),
      signingIn: null,
    });
  });
  it('answers the cached status within 60 s and probes again after', async () => {
    const { services, clock, world } = setup({ gh: '/gh', answer: 'octocat' });
    await services.githubStatus(false);
    clock.advance(STATUS_FRESH_MS - 1);
    await services.githubStatus(false);
    expect(world.probes).toBe(1);
    world.answer = 'hubot';
    clock.advance(1);
    await expect(services.githubStatus(false)).resolves.toMatchObject({ login: 'hubot' });
    expect(world.probes).toBe(2);
  });
  it('a recheck resolves gh again and probes: not installed, installed, then signed in', async () => {
    const { services, world } = setup({ gh: null, answer: 'octocat' });
    await expect(services.githubStatus(true)).resolves.toMatchObject({ state: 'not_installed' });
    world.gh = '/opt/homebrew/bin/gh';
    // The cached answer stands until a recheck.
    await expect(services.githubStatus(false)).resolves.toMatchObject({ state: 'not_installed' });
    await expect(services.githubStatus(true)).resolves.toMatchObject({
      state: 'signed_in',
      login: 'octocat',
    });
    expect(world.resolved).toBe(2);
  });
});

describe('Sign In', () => {
  it('answers the code, shows it in the status of a screen mounted meanwhile, and a second POST is 409', async () => {
    const { services, world } = setup({ gh: '/gh', answer: null });
    const post = services.startGithubSignin();
    world.children[0]?.print(
      '! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n',
    );
    await expect(post).resolves.toEqual({
      code: 'ABCD-1234',
      url: 'https://github.com/login/device',
    });
    const status = await services.githubStatus(false);
    expect(status.signingIn).toMatchObject({
      code: 'ABCD-1234',
      url: 'https://github.com/login/device',
    });
    await expect(services.startGithubSignin()).rejects.toMatchObject({ code: 'conflict' });
  });
  it('resolves gh again before it spawns', () => {
    const { services, world } = setup({ gh: '/gh', answer: null });
    void services.startGithubSignin().catch(() => undefined);
    expect(world.resolved).toBe(1);
  });
  it('on gh exiting 0 the cached status shows the new login before the event goes out', async () => {
    const { services, world } = setup({ gh: '/gh', answer: null });
    await expect(services.githubStatus(true)).resolves.toMatchObject({ state: 'signed_out' });
    const post = services.startGithubSignin();
    world.children[0]?.print('one-time code: ABCD-1234\nhttps://github.com/login/device\n');
    await post;
    world.answer = 'octocat';
    world.children[0]?.exit(0);
    await flush();
    expect(world.events).toEqual([{ ok: true, login: 'octocat', message: null, cancelled: false }]);
    expect(world.seenByEvent).toEqual([
      expect.objectContaining({ state: 'signed_in', login: 'octocat', signingIn: null }),
    ]);
    // The read at the end is the only probe the status needed.
    expect(world.probes).toBe(2);
  });
  it('the end reads the login in a probe that starts after one already running', async () => {
    const { services, world } = setup({ gh: '/gh', answer: null });
    let release: () => void = () => undefined;
    world.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A status read starts a probe that sees gh before it saved the token.
    const early = services.githubStatus(false);
    await flush();
    const post = services.startGithubSignin();
    world.children[0]?.print('one-time code: ABCD-1234\nhttps://github.com/login/device\n');
    await post;
    world.answer = 'octocat';
    world.children[0]?.exit(0);
    release();
    await early;
    await flush();
    expect(world.events).toEqual([{ ok: true, login: 'octocat', message: null, cancelled: false }]);
    expect(world.probes).toBe(2);
  });
  it('a recheck never returns a probe that began before it', async () => {
    const { services, world } = setup({ gh: null, answer: 'octocat' });
    let release: () => void = () => undefined;
    world.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const early = services.githubStatus(false);
    await flush();
    world.gh = '/opt/homebrew/bin/gh';
    const rechecked = services.githubStatus(true);
    release();
    await early;
    await expect(rechecked).resolves.toMatchObject({ state: 'signed_in', login: 'octocat' });
  });
  it('DELETE ends the sign-in as cancelled and the status returns to what it was', async () => {
    const { services, world } = setup({ gh: '/gh', answer: null });
    await services.githubStatus(false);
    const post = services.startGithubSignin();
    world.children[0]?.print('one-time code: ABCD-1234\nhttps://github.com/login/device\n');
    await post;
    services.cancelGithubSignin();
    expect(world.events).toEqual([
      { ok: false, login: null, message: 'Sign-in cancelled.', cancelled: true },
    ]);
    await expect(services.githubStatus(false)).resolves.toMatchObject({
      state: 'signed_out',
      signingIn: null,
    });
  });
  it('a start with no gh installed is a 409 and the slot stays free', async () => {
    const { services } = setup({ gh: null, answer: null });
    await expect(services.startGithubSignin()).rejects.toMatchObject({ code: 'conflict' });
  });
});
