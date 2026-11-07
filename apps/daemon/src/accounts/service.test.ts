import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountInput,
  AccountKind,
  AccountLoginEndedData,
  AccountPauseReason,
  AccountProblem,
  ConflictError,
  EventType,
  type AccountId,
  type DaemonEvent,
} from '@10db/contracts';
import {
  createTestStore,
  listAccountModels,
  seedProject,
  type Store,
  type WriteContext,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  capturingLogger,
  createMemoryKeychain,
  seedSpend,
  tempDir,
  waitFor,
} from '../../test/fixtures';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import { createAccountLists, parseCatalogue } from '../catalogue';
import { ManualClock } from '../clock';
import { AccountLaunchError, createLauncher, KeychainError, type Launcher } from '../environment';
import { createEventBus, createStateStore } from '../events';
import { FakeAdapter, type SeenAccount } from '../sessions';
import { createListRefresh } from './list-refresh';
import type { AccountPause } from './pauses';
import { createAccountService, type AccountService } from './service';
import { createStartGate, type StartGate } from './start-gate';

let dir: { path: string; cleanup(): void };
let close: () => void;
let adapter: FakeAdapter;
let gate: StartGate;
let service: AccountService;
let store: Store;
let logger: ReturnType<typeof capturingLogger>;
/** Running lanes per account, as the runner reports them. */
const live = new Map<AccountId, number>();
const ended: AccountLoginEndedData[] = [];
let saves = 0;
/** What the launcher does for a probe; the real one unless a test replaces it. */
let probeFor: Launcher['probe'];
let failWrites = false;
const activePauses = new Map<AccountId, AccountPause>();
const lifted: AccountId[] = [];

beforeEach(() => {
  activePauses.clear();
  lifted.length = 0;
  live.clear();
  ended.length = 0;
  saves = 0;
  failWrites = false;
  logger = capturingLogger();
  dir = tempDir('account service');
  const clock = new ManualClock(new Date(2026, 9, 20));
  const test = createTestStore(() => clock.now());
  close = test.close;
  store = test.store;
  adapter = new FakeAdapter({});
  gate = createStartGate();
  const keychain = createMemoryKeychain();
  const bus = createEventBus();
  bus.subscribe((event: DaemonEvent) => {
    if (event.type === EventType.AccountLoginEnded)
      ended.push(AccountLoginEndedData.parse(event.data));
  });
  const launcher = createLauncher({ base: {}, clientApp: 'test', keychain });
  probeFor = (row) => launcher.probe(row);
  const state = createStateStore(test.store, bus);
  const lists = createAccountLists({
    state,
    clock,
    catalogue: () => parseCatalogue(readModelsDevFixture()),
    logger,
  });
  service = createAccountService({
    state: {
      db: state.db,
      now: () => state.now(),
      write<T>(fn: (ctx: WriteContext) => T): T {
        if (failWrites) throw new Error('disk is full: secret-payload');
        return state.write(fn);
      },
    },
    clock,
    dataDir: dir.path,
    keychain,
    launcher: { probe: (row) => probeFor(row) },
    logger,
    liveLanes: (id) => live.get(id) ?? 0,
    adapter,
    lists,
    listRefresh: createListRefresh({
      state,
      clock,
      adapter,
      launcher: { probe: (row) => probeFor(row) },
      startGate: gate,
      lists,
      dataDir: dir.path,
      logger,
    }),
    startGate: gate,
    runtime: { saved: () => undefined },
    pauses: {
      pausedFor: (id) => activePauses.get(id) ?? null,
      resume: (id) => {
        lifted.push(id);
        activePauses.delete(id);
      },
    },
    onSaved: () => {
      saves += 1;
    },
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
        settings: { baseUrl: 'https://gw.example/api' },
      }),
    );
    service.setSecret(account.id, { secret: 'not-a-real-gateway-token-0001' });
    const held = await gate.acquire(account.id);
    await service.identity(account.id);
    expect(adapter.probes).toHaveLength(1);
    held();
  });
});

describe('the models an account lists', () => {
  const OPUS = { id: 'opus', resolvedId: 'claude-opus-5-5', efforts: ['low' as const] };
  const stored = (id: AccountId) => listAccountModels(store.db, id).map((m) => m.model);

  it.each<[string, Partial<SeenAccount>, string[]]>([
    ['a signed-in account', {}, ['claude-opus-5-5']],
    [
      'a signed-out process, which still answers a listing',
      { email: undefined, subscriptionType: undefined },
      [],
    ],
    ['credentials that are not the kind', { apiProvider: 'bedrock' }, []],
  ])('are stored for %s only when the account check passes', async (_name, seen, expected) => {
    const { account } = service.create(
      AccountInput.parse({ kind: AccountKind.ClaudeSubscription, label: 'A' }),
    );
    adapter.probeSeen = { ...adapter.probeSeen, ...seen, models: [OPUS] };
    await service.identity(account.id);
    expect(stored(account.id)).toEqual(expected);
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
      models: [{ id: 'gpt-6-astra', resolvedId: null, efforts: ['low'] }],
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

describe('connect', () => {
  const signIn = (kind: AccountKind = AccountKind.ClaudeSubscription) =>
    service.create(AccountInput.parse({ kind, label: 'Plan A' })).account;
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('refuses an account with a lane running, and starts nothing', async () => {
    const account = signIn();
    live.set(account.id, 1);
    await expect(service.connect(account.id)).rejects.toThrow(/lane running/);
    await expect(service.connect(account.id)).rejects.toBeInstanceOf(ConflictError);
    expect(adapter.logins).toHaveLength(0);
    expect(service.connecting()).toBeNull();
    live.clear();
    await service.connect(account.id);
    expect(adapter.logins).toHaveLength(1);
  });

  it('refuses an archived account', async () => {
    const account = signIn();
    service.archive(account.id);
    await expect(service.connect(account.id)).rejects.toThrow(/archived/);
    expect(adapter.logins).toHaveLength(0);
  });

  it.each([
    {
      name: 'a launch refusal',
      error: (id: AccountId) =>
        new AccountLaunchError(id, AccountProblem.SecretMissing, 'Account "Plan A" has no secret'),
      message: /no secret/,
    },
    {
      name: 'a locked Keychain',
      error: () => new KeychainError('Reading the Keychain failed (security exit status 51)'),
      message: /Keychain failed/,
    },
  ])('answers a conflict with the reason for $name', async ({ error, message }) => {
    const account = signIn();
    probeFor = () => {
      throw error(account.id);
    };
    await expect(service.connect(account.id)).rejects.toThrow(message);
    await expect(service.connect(account.id)).rejects.toBeInstanceOf(ConflictError);
    expect(service.connecting()).toBeNull();
    expect(adapter.logins).toHaveLength(0);
  });

  it('reports the account that holds the slot until its sign-in ends, then tells the scheduler', async () => {
    const account = signIn();
    expect(service.connecting()).toBeNull();
    await service.connect(account.id);
    expect(service.connecting()).toEqual({ accountId: account.id, label: 'Plan A' });
    adapter.logins[0]?.end({ ok: true });
    await waitFor(() => service.connecting() === null, 2_000);
    expect(ended).toEqual([
      { accountId: account.id, ok: true, message: 'Signed in.', cancelled: false },
    ]);
    expect(saves).toBeGreaterThan(0);
  });

  it.each<[string, { ok: true } | { ok: false; message: string }, string[]]>([
    ['a finished sign-in', { ok: true }, ['claude-opus-5-5']],
    ['a failed sign-in', { ok: false, message: 'The sign-in took too long.' }, []],
  ])(
    'reads the list for %s with no one asking for the identity',
    async (_name, outcome, expected) => {
      const account = signIn();
      adapter.probeSeen = {
        ...adapter.probeSeen,
        models: [{ id: 'opus', resolvedId: 'claude-opus-5-5', efforts: ['low'] }],
      };
      await service.connect(account.id);
      adapter.logins[0]?.end(outcome);
      await waitFor(() => service.connecting() === null, 2_000);
      await waitFor(
        () => expected.length === 0 || listAccountModels(store.db, account.id).length > 0,
        2_000,
      );
      expect(listAccountModels(store.db, account.id).map((m) => m.model)).toEqual(expected);
    },
  );

  it('marks a sign-in the builder cancelled as cancelled, and one that failed as not', async () => {
    const account = signIn();
    await service.connect(account.id);
    adapter.logins[0]?.end({ ok: false, message: 'The sign-in took too long.' });
    await waitFor(() => ended.length === 1, 2_000);
    await service.connect(account.id);
    await service.cancelConnect(account.id);
    await waitFor(() => ended.length === 2, 2_000);
    expect(ended.map((e) => [e.ok, e.cancelled])).toEqual([
      [false, false],
      [false, true],
    ]);
    expect(service.connecting()).toBeNull();
  });

  it('honours a cancel that arrives while the login is still starting', async () => {
    const account = signIn();
    let release: () => void = () => undefined;
    const real = adapter.startLogin.bind(adapter);
    adapter.startLogin = async (spec) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return real(spec);
    };
    const connecting = service.connect(account.id);
    await flush();
    await service.cancelConnect(account.id);
    expect(service.connecting()).toEqual({ accountId: account.id, label: 'Plan A' });
    release();
    // No page is handed back for a login that is already cancelled.
    await expect(connecting).resolves.toEqual({ accountId: account.id, authUrl: null });
    await waitFor(() => ended.length === 1, 2_000);
    expect(adapter.logins[0]?.cancelled).toBe(true);
    expect(ended[0]?.cancelled).toBe(true);
    expect(service.connecting()).toBeNull();
  });

  it('stop ends a waiting sign-in, tells the UI before it returns, and refuses a new one', async () => {
    const account = signIn();
    await service.connect(account.id);
    await service.stop();
    expect(adapter.logins[0]?.cancelled).toBe(true);
    // The builder did not cancel it: the UI says what happened and offers Connect again.
    expect(ended).toEqual([
      {
        accountId: account.id,
        ok: false,
        message: '10db stopped before the sign-in finished. Try Connect again.',
        cancelled: false,
      },
    ]);
    expect(service.connecting()).toBeNull();
    await expect(service.connect(account.id)).rejects.toThrow(/stopping/);
  });

  it('stop waits for a login that is still starting, then ends it', async () => {
    const account = signIn();
    let release: () => void = () => undefined;
    const real = adapter.startLogin.bind(adapter);
    adapter.startLogin = async (spec) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return real(spec);
    };
    void service.connect(account.id);
    await flush();
    const stopped = service.stop();
    release();
    await stopped;
    expect(adapter.logins[0]?.cancelled).toBe(true);
    expect(service.connecting()).toBeNull();
  });

  it('logs a warning with no payload when the end of a sign-in cannot be recorded', async () => {
    const account = signIn();
    await service.connect(account.id);
    failWrites = true;
    adapter.logins[0]?.end({ ok: true });
    await waitFor(() => service.connecting() === null, 2_000);
    await waitFor(() => logger.lines().length > 0, 2_000);
    const logged = logger.lines().join('\n');
    expect(logged).toContain('could not record');
    expect(logged).not.toContain('secret-payload');
    expect(logged).not.toContain('disk is full');
  });
});
