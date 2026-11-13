import { GithubSigninDto, GithubStatusDto } from '@10db/contracts';
import { defineWebSocketHelper } from 'hono/ws';
import { beforeEach, describe, expect, it } from 'vitest';
import { stubServices } from '../../test/api-stub';
import { ManualClock } from '../clock';
import { createGithubServices } from '../daemon';
import { GhError, GhFailure, type GhLoginChild } from '../github';
import { createApp } from './app';

const TOKEN = 'ui-token';

class FakeChild implements GhLoginChild {
  signals: NodeJS.Signals[] = [];
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

let clock: ManualClock;
let children: FakeChild[];
let gh: string | null;
let login: string | null | GhError;
let request: (path: string, method?: string) => Promise<Response>;

beforeEach(() => {
  clock = new ManualClock();
  children = [];
  gh = '/opt/homebrew/bin/gh';
  login = null;
  const github = createGithubServices({
    clock,
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    resolveGh: () => gh,
    readLogin: () => {
      if (gh === null)
        return Promise.reject(new GhError(GhFailure.NotInstalled, 'gh is not installed'));
      return login instanceof GhError ? Promise.reject(login) : Promise.resolve(login);
    },
    env: () => ({}),
    emit: () => undefined,
  });
  const app = createApp({
    onUnexpectedError: () => undefined,
    startedAt: new Date(),
    allowedOrigins: [],
    token: TOKEN,
    services: stubServices({ ...github }),
    upgradeWebSocket: defineWebSocketHelper(() => new Response(null, { status: 426 })),
    mcp: () => Promise.resolve(new Response('mcp')),
    builderMcp: () => Promise.resolve(new Response('builder')),
  });
  request = (path, method = 'GET') =>
    Promise.resolve(app.request(path, { method, headers: { Authorization: `Bearer ${TOKEN}` } }));
});

const PRINTED =
  '! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n';

describe('GET /github', () => {
  it('answers the status, and a recheck looks for gh again', async () => {
    gh = null;
    const first = GithubStatusDto.parse(await (await request('/github')).json());
    expect(first.state).toBe('not_installed');
    gh = '/opt/homebrew/bin/gh';
    login = 'octocat';
    // Cached until a recheck.
    expect(GithubStatusDto.parse(await (await request('/github')).json()).state).toBe(
      'not_installed',
    );
    expect(GithubStatusDto.parse(await (await request('/github?recheck=1')).json())).toMatchObject({
      state: 'signed_in',
      login: 'octocat',
    });
  });
  it('answers unreachable, never signed out, when gh could not tell', async () => {
    login = new GhError(GhFailure.Unreachable, 'offline');
    const status = GithubStatusDto.parse(await (await request('/github?recheck=1')).json());
    expect(status.state).toBe('unreachable');
  });
  it('refuses a recheck value other than 1', async () => {
    expect((await request('/github?recheck=yes')).status).toBe(400);
  });
  it('is behind the token', async () => {
    const res = await createApp({
      onUnexpectedError: () => undefined,
      startedAt: new Date(),
      allowedOrigins: [],
      token: TOKEN,
      services: stubServices(),
      upgradeWebSocket: defineWebSocketHelper(() => new Response(null, { status: 426 })),
      mcp: () => Promise.resolve(new Response('mcp')),
      builderMcp: () => Promise.resolve(new Response('builder')),
    }).request('/github');
    expect(res.status).toBe(401);
  });
});

describe('POST and DELETE /github/signin', () => {
  it('answers the code and page; a second POST is 409; DELETE is 204 and kills gh', async () => {
    const post = request('/github/signin', 'POST');
    await Promise.resolve();
    children[0]?.print(PRINTED);
    const res = await post;
    expect(res.status).toBe(200);
    expect(GithubSigninDto.parse(await res.json())).toEqual({
      code: 'ABCD-1234',
      url: 'https://github.com/login/device',
    });
    const second = await request('/github/signin', 'POST');
    expect(second.status).toBe(409);
    const del = await request('/github/signin', 'DELETE');
    expect(del.status).toBe(204);
    expect(children[0]?.signals).toEqual(['SIGTERM']);
    // The slot is free again.
    void request('/github/signin', 'POST');
    await Promise.resolve();
    expect(children).toHaveLength(2);
  });
  it('is 409 with a message when gh is not installed', async () => {
    gh = null;
    const res = await request('/github/signin', 'POST');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'conflict' });
  });
  it('is 502 when gh prints no code in 5 s', async () => {
    const post = request('/github/signin', 'POST');
    await Promise.resolve();
    clock.advance(5_000);
    const res = await post;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream', message: "gh didn't print a code" });
  });
  it('DELETE with nothing running is 204', async () => {
    expect((await request('/github/signin', 'DELETE')).status).toBe(204);
  });
});
