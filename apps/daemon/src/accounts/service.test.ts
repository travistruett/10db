import { AccountInput, AccountKind } from '@10db/contracts';
import { createTestStore } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryKeychain, tempDir, waitFor } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createLauncher } from '../environment';
import { createEventBus, createStateStore } from '../events';
import { FakeAdapter } from '../sessions';
import { createAccountService, type AccountService } from './service';
import { createStartGate, type StartGate } from './start-gate';

let dir: { path: string; cleanup(): void };
let close: () => void;
let adapter: FakeAdapter;
let gate: StartGate;
let service: AccountService;

beforeEach(() => {
  dir = tempDir('account service');
  const clock = new ManualClock(new Date(2026, 9, 20));
  const test = createTestStore(() => clock.now());
  close = test.close;
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
