import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountInput,
  AccountKind,
  AccountPauseReason,
  ConflictError,
  type AccountId,
} from '@10db/contracts';
import { createTestStore, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryKeychain, seedSpend, tempDir, waitFor } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createLauncher } from '../environment';
import { createEventBus, createStateStore } from '../events';
import { FakeAdapter } from '../sessions';
import type { AccountPause } from './pauses';
import { createAccountService, type AccountService } from './service';
import { createStartGate, type StartGate } from './start-gate';

let dir: { path: string; cleanup(): void };
let close: () => void;
let adapter: FakeAdapter;
let gate: StartGate;
let service: AccountService;
let store: Store;
const activePauses = new Map<AccountId, AccountPause>();
const lifted: AccountId[] = [];

beforeEach(() => {
  activePauses.clear();
  lifted.length = 0;
  dir = tempDir('account service');
  const clock = new ManualClock(new Date(2026, 9, 20));
  const test = createTestStore(() => clock.now());
  close = test.close;
  store = test.store;
  adapter = new FakeAdapter({});
  gate = createStartGate();
  const keychain = createMemoryKeychain();
  service = createAccountService({
    state: createStateStore(test.store, createEventBus()),
    clock,
    dataDir: dir.path,
    keychain,
    launcher: createLauncher({ base: {}, clientApp: 'test', keychain }),
    adapter,
    startGate: gate,
    runtime: { saved: () => undefined },
    pauses: {
      pausedFor: (id) => activePauses.get(id) ?? null,
      resume: (id) => {
        lifted.push(id);
        activePauses.delete(id);
      },
    },
    onSaved: () => undefined,
  });
});
afterEach(() => {
  close();
  dir.cleanup();
});

describe('identity', () => {
  it('queues a subscription probe behind a session start on the same account', async () => {
    const { account } = service.create(
      AccountInput.parse({ kind: AccountKind.ClaudeSubscription, label: 'A' }),
    );
    const release = await gate.acquire(account.id);
    const identity = service.identity(account.id);
    await waitFor(() => gate.waiting(account.id) === 1, 2_000);
    expect(adapter.probes).toEqual([]);

    release();
    expect((await identity).email).not.toBeNull();
    expect(adapter.probes).toHaveLength(1);
  });

  it('does not queue a keyed account behind anything', async () => {
    const { account } = service.create(
      AccountInput.parse({
        kind: AccountKind.Gateway,
        label: 'G',
        settings: { baseUrl: 'https://gw.example/api', aliases: ['haiku'] },
      }),
    );
    service.setSecret(account.id, { secret: 'not-a-real-gateway-token-0001' });
    const held = await gate.acquire(account.id);
    await service.identity(account.id);
    expect(adapter.probes).toHaveLength(1);
    held();
  });
});

describe('a ChatGPT account', () => {
  const create = () =>
    service.create(AccountInput.parse({ kind: AccountKind.CodexSignin, label: 'ChatGPT plan' }));

  it('gives a codex_signin account a home named codex, mode 700, and its sign-in steps', () => {
    const { account, signIn } = create();
    expect(account.configDir).toBe(join(dir.path, 'accounts', account.id, 'codex'));
    expect(statSync(account.configDir ?? '').mode & 0o777).toBe(0o700);
    expect(signIn?.configDir).toBe(account.configDir);
    expect(signIn?.command).toContain('CODEX_HOME=');
    expect(signIn?.command).toContain('codex login');
    expect(signIn?.command).not.toContain('claude');
    expect(service.signIn(account.id).command).toBe(signIn?.command);
  });

  it('probes as a codex_signin account without waiting on the Claude start gate, and reports the models', async () => {
    const { account } = create();
    adapter.probeSeen = {
      ...adapter.probeSeen,
      email: 'me@example.com',
      organization: 'ws-1',
      subscriptionType: 'pro',
      apiProvider: 'chatgpt',
      models: ['gpt-6-astra'],
    };
    const held = await gate.acquire(account.id);
    const identity = await service.identity(account.id);
    held();
    expect(adapter.probes[0]?.kind).toBe(AccountKind.CodexSignin);
    expect(adapter.probes[0]?.env['CODEX_HOME']).toBe(account.configDir);
    expect(identity).toMatchObject({
      email: 'me@example.com',
      organization: 'ws-1',
      apiProvider: 'chatgpt',
      subscription: true,
      models: ['gpt-6-astra'],
      refusal: {
        problem: 'unconfirmed',
        seenIdentity: 'me@example.com · ws-1',
      },
    });
  });

  it('reports no models for a Claude account', async () => {
    const { account } = service.create(
      AccountInput.parse({ kind: AccountKind.ClaudeSubscription, label: 'A' }),
    );
    expect((await service.identity(account.id)).models).toEqual([]);
  });
});

describe('pauses', () => {
  const since = new Date(2026, 9, 20);
  const keyed = (label: string) =>
    service.create(AccountInput.parse({ kind: AccountKind.AnthropicApiKey, label })).account;

  it('lists each paused account with its reason, since and until, and none that is free', () => {
    const refused = keyed('Refused');
    const limited = keyed('Limited');
    keyed('Free');
    const until = new Date(since.getTime() + 3_600_000);
    activePauses.set(refused.id, { reason: AccountPauseReason.Refused, until: null, since });
    activePauses.set(limited.id, { reason: AccountPauseReason.UsageLimit, until, since });
    const listed = service.pauses();
    expect(listed).toHaveLength(2);
    expect(listed).toContainEqual({
      accountId: refused.id,
      reason: 'refused',
      since: since.toISOString(),
      until: null,
    });
    expect(listed).toContainEqual({
      accountId: limited.id,
      reason: 'usage_limit',
      since: since.toISOString(),
      until: until.toISOString(),
    });
  });

  it.each([AccountPauseReason.Refused, AccountPauseReason.MonthlyCap])(
    'lifts a %s pause on resume',
    (reason) => {
      const account = keyed('A');
      activePauses.set(account.id, { reason, until: null, since });
      expect(service.resume(account.id)).toEqual([]);
      expect(lifted).toEqual([account.id]);
    },
  );

  it('refuses to resume a monthly-cap pause while spend is still at the cap, naming the fix', () => {
    const account = service.create(
      AccountInput.parse({ kind: AccountKind.AnthropicApiKey, label: 'Capped', monthlyCapUsd: 5 }),
    ).account;
    const project = seedProject(store, { accountId: account.id });
    seedSpend(store, project, 5);
    activePauses.set(account.id, { reason: AccountPauseReason.MonthlyCap, until: null, since });
    const attempt = () => service.resume(account.id);
    expect(attempt).toThrow(ConflictError);
    expect(attempt).toThrow(/raise the cap or wait for next month/);
    expect(lifted).toEqual([]);
    expect(activePauses.has(account.id)).toBe(true);
  });

  it('resumes a monthly-cap pause once the cap is raised above the spend', () => {
    const account = service.create(
      AccountInput.parse({ kind: AccountKind.AnthropicApiKey, label: 'Capped', monthlyCapUsd: 5 }),
    ).account;
    const project = seedProject(store, { accountId: account.id });
    seedSpend(store, project, 5);
    activePauses.set(account.id, { reason: AccountPauseReason.MonthlyCap, until: null, since });
    service.patch(account.id, { monthlyCapUsd: 10 });
    expect(service.resume(account.id)).toEqual([]);
    expect(lifted).toEqual([account.id]);
  });

  it('refuses to resume a usage-limit pause, which ends by itself', () => {
    const account = keyed('A');
    activePauses.set(account.id, { reason: AccountPauseReason.UsageLimit, until: since, since });
    expect(() => service.resume(account.id)).toThrow(ConflictError);
    expect(lifted).toEqual([]);
  });

  it('answers a resume of an account that is not paused with the pauses as they are', () => {
    const account = keyed('A');
    expect(service.resume(account.id)).toEqual([]);
    expect(lifted).toEqual([]);
  });
});
