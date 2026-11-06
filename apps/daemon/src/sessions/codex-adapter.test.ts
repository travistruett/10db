import { AccountKind, AccountProblem, mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { checkAccount } from './account-check';
import { createCodexAdapter } from './codex-adapter';
import { fakeAppServer, type FakeAppServer } from './codex-test-support';
import {
  AccountProbeError,
  CompletionError,
  type SessionAdapter,
  type SessionEvent,
  type SessionHandle,
} from './types';

const SIGNED_IN = {
  initialize: { userAgent: 'codex/0.154.0', codexHome: '/h/codex' },
  'account/read': {
    account: { type: 'chatgpt', email: 'me@example.com', planType: 'pro' },
    requiresOpenaiAuth: true,
  },
  'account/rateLimits/read': {
    rateLimits: { limitId: 'codex', primary: { usedPercent: 12 } },
    accountId: 'ws-1',
  },
  'model/list': {
    data: [
      { id: 'astra', model: 'gpt-6-astra', isDefault: true },
      { id: 'sol', model: 'gpt-5.6-sol' },
      { id: 'secret', model: 'gpt-hidden', hidden: true },
    ],
  },
};

function adapterOn(server: FakeAppServer, clock: ManualClock = new ManualClock()): SessionAdapter {
  return createCodexAdapter({
    codexPath: '/opt/codex',
    logger: silentLogger,
    spawn: server.spawn,
    clock,
  });
}

const probe = { cwd: '/d', env: { PATH: '/bin' }, kind: AccountKind.CodexSignin } as const;

const expectation = (identity: string | null) => ({
  accountId: mintId('Account'),
  label: 'ChatGPT plan',
  kind: AccountKind.CodexSignin,
  identity,
});

async function events(handle: SessionHandle): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = [];
  for await (const event of handle.events) seen.push(event);
  return seen;
}

describe('probeAccount', () => {
  it('reads who the account is from account/read, its workspace from the usage read and its models from model/list', async () => {
    const server = fakeAppServer(SIGNED_IN);
    const seen = await adapterOn(server).probeAccount(probe);
    expect(seen).toMatchObject({
      apiProvider: 'chatgpt',
      email: 'me@example.com',
      subscriptionType: 'pro',
      organization: 'ws-1',
      models: ['gpt-6-astra', 'gpt-5.6-sol'],
    });
    expect(server.sent().map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'account/rateLimits/read',
      'model/list',
    ]);
    expect(server.killed()).toBe(true);
  });

  it('gives an identity the account check accepts as the email and the workspace', async () => {
    const seen = await adapterOn(fakeAppServer(SIGNED_IN)).probeAccount(probe);
    expect(checkAccount(expectation('me@example.com · ws-1'), seen)).toBeNull();
    expect(checkAccount(expectation('me@example.com · ws-2'), seen)).toMatchObject({
      problem: AccountProblem.IdentityMismatch,
    });
  });

  it.each([
    ['fails', { error: { code: -32000, message: 'no usage' } }],
    ['names no workspace', { rateLimits: { limitId: 'codex' } }],
    ['names a null workspace', { rateLimits: { limitId: 'codex' }, accountId: null }],
  ])('rejects with AccountProbeError when the usage read %s', async (_name, usage) => {
    const server = fakeAppServer({ ...SIGNED_IN, 'account/rateLimits/read': usage });
    const error = await adapterOn(server)
      .probeAccount(probe)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountProbeError);
    expect(server.killed()).toBe(true);
  });

  it('still reports the account, with no models, when model/list fails', async () => {
    const server = fakeAppServer({
      ...SIGNED_IN,
      'model/list': { error: { code: -32000, message: 'no list' } },
    });
    const seen = await adapterOn(server).probeAccount(probe);
    expect(seen).toMatchObject({ email: 'me@example.com', organization: 'ws-1' });
    expect(seen.models).toBeUndefined();
  });

  it('reports nothing for a signed-out home', async () => {
    const server = fakeAppServer({
      ...SIGNED_IN,
      'account/read': { account: null, requiresOpenaiAuth: true },
    });
    const seen = await adapterOn(server).probeAccount(probe);
    expect(seen.email).toBeUndefined();
    expect(checkAccount(expectation(null), seen)).toMatchObject({
      problem: AccountProblem.SignedOut,
    });
    expect(server.sent().map((m) => m.method)).not.toContain('account/rateLimits/read');
  });

  it('rejects with AccountProbeError when the app-server does not answer in time, and closes it', async () => {
    const clock = new ManualClock();
    const server = fakeAppServer({ ...SIGNED_IN, initialize: () => new Promise(() => undefined) });
    const result = adapterOn(server, clock)
      .probeAccount(probe)
      .catch((e: unknown) => e);
    clock.advance(30_000);
    const error = await result;
    expect(error).toBeInstanceOf(AccountProbeError);
    expect(String(error)).toContain('30 s');
    expect(server.killed()).toBe(true);
  });

  it('rejects with AccountProbeError, saying nothing from the child, when it exits', async () => {
    const server = fakeAppServer({ ...SIGNED_IN, initialize: () => new Promise(() => undefined) });
    const result = adapterOn(server)
      .probeAccount(probe)
      .catch((e: unknown) => e);
    server.writeStderr('signed in as secret@example.com');
    server.exit(1);
    const error = await result;
    expect(error).toBeInstanceOf(AccountProbeError);
    expect(String(error)).not.toContain('secret@example.com');
  });

  it('rejects with AccountProbeError when account/read is refused', async () => {
    const server = fakeAppServer({
      ...SIGNED_IN,
      'account/read': { error: { code: -32000, message: 'a@b.example is not allowed' } },
    });
    const error = await adapterOn(server)
      .probeAccount(probe)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountProbeError);
    expect(String(error)).not.toContain('a@b.example');
    expect(server.killed()).toBe(true);
  });
});

describe('the rest of the adapter', () => {
  it('rejects complete with a CompletionError', async () => {
    const adapter = adapterOn(fakeAppServer({}));
    const error = await adapter
      .complete({
        cwd: '/d',
        prompt: 'hi',
        model: 'gpt-6-astra',
        env: {},
        account: expectation(null),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompletionError);
  });

  it('ends a Shape conversation at once, saying brainstorm chat is not available on a ChatGPT account', async () => {
    // The spec is never read: the conversation ends before it starts.
    const handle = adapterOn(fakeAppServer({})).startShape({} as never);
    const [ended] = await events(handle);
    expect(ended).toMatchObject({ type: 'ended', reason: 'error' });
    expect(JSON.stringify(ended)).toContain('ChatGPT');
  });
});
