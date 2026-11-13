import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import type { AccountId } from '@10db/contracts';
import {
  createTestStore,
  getAccountRow,
  getJudgeConfig,
  insertAccount,
  listAccounts,
  patchJudgeConfig,
  recordAccountSecret,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KeychainError,
  keychainWith,
  OPENROUTER_KEY_ACCOUNT,
  secretFingerprint,
  type Keychain,
} from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger, type Logger } from '../log';
import { moveOpenRouterKey } from './openrouter-key-move';

const KEY = 'sk-or-v1-0123456789abcdef-OLD-ITEM';

let store: Store;
let close: () => void;
let state: StateStore;
beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
});
afterEach(() => {
  close();
});

interface Faults {
  /** Fails the write of items whose account name starts with this. */
  failWriteOf?: string;
  failRemove?: boolean;
  failReadOld?: boolean;
  /** Stores something other than what was asked, as a `security -i` that reported nothing wrong might. */
  mangleWrites?: boolean;
}

/** A Keychain over a `security` double at the process boundary, so the real write, read-back and remove run. */
function keychainOver(items: Map<string, string>, faults: Faults = {}) {
  const calls: string[] = [];
  const exec = (
    _command: string,
    args: readonly string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ): string => {
    const account =
      args[0] === '-i'
        ? (/-a "([^"]+)"/.exec(typeof options.input === 'string' ? options.input : '')?.[1] ?? '')
        : (args[args.indexOf('-a') + 1] ?? '');
    calls.push(`${args[0] ?? ''} ${account}`);
    const fail = (status: number): never => {
      throw Object.assign(new Error('security failed'), { status });
    };
    if (args[0] === '-i') {
      if (faults.failWriteOf !== undefined && account.startsWith(faults.failWriteOf)) fail(36);
      const match = /-w "([^"]*)"/.exec(typeof options.input === 'string' ? options.input : '');
      items.set(account, faults.mangleWrites === true ? 'mangled-value' : (match?.[1] ?? ''));
      return '';
    }
    if (args[0] === 'delete-generic-password') {
      if (faults.failRemove === true) fail(36);
      if (!items.delete(account)) fail(44);
      return '';
    }
    if (faults.failReadOld === true && account === OPENROUTER_KEY_ACCOUNT) fail(36);
    const value = items.get(account);
    if (value === undefined) fail(44);
    return `${value ?? ''}\n`;
  };
  const keychain: Keychain = keychainWith(exec);
  return { keychain, calls };
}

const warnings: Record<string, unknown>[] = [];
const logger: Logger = {
  ...silentLogger,
  warn: (fields) => {
    warnings.push(fields as Record<string, unknown>);
  },
};
beforeEach(() => {
  warnings.length = 0;
});

function openRouterAccount(label: string, secret: string | null, archived = false): AccountId {
  const account = state.write((ctx) => {
    const created = insertAccount(ctx, { kind: 'openrouter', label }, { configDirFor: () => '/x' });
    if (secret !== null) recordAccountSecret(ctx, created.id, secretFingerprint(secret));
    return created;
  });
  if (archived)
    store.db.$client.prepare('UPDATE accounts SET archived = 1 WHERE id = ?').run(account.id);
  return account.id;
}

const openRouterAccounts = () =>
  listAccounts(store.db, { includeArchived: true }).filter((a) => a.kind === 'openrouter');

describe('moveOpenRouterKey', () => {
  it('moves the old key into an account of its own, then removes the old item', async () => {
    const items = new Map([[OPENROUTER_KEY_ACCOUNT, KEY]]);
    const { keychain } = keychainOver(items);
    await moveOpenRouterKey({ state, keychain, logger });
    const [account] = openRouterAccounts();
    expect(openRouterAccounts()).toHaveLength(1);
    expect(account).toMatchObject({ label: 'OpenRouter', secretSet: true, archived: false });
    if (!account) throw new Error('no account was made');
    expect(items.get(`account:${account.id}`)).toBe(KEY);
    expect(getAccountRow(store.db, account.id).secretFingerprint).toBe(secretFingerprint(KEY));
    expect(getJudgeConfig(store.db).accountId).toBe(account.id);
    expect(items.has(OPENROUTER_KEY_ACCOUNT)).toBe(false);
  });

  it('does nothing when there is no old item', async () => {
    const items = new Map<string, string>();
    const { keychain, calls } = keychainOver(items);
    await moveOpenRouterKey({ state, keychain, logger });
    expect(openRouterAccounts()).toEqual([]);
    expect(calls).toEqual([`find-generic-password ${OPENROUTER_KEY_ACCOUNT}`]);
  });

  it('leaves the old item alone when the builder already has an OpenRouter account of another key', async () => {
    const items = new Map([[OPENROUTER_KEY_ACCOUNT, KEY]]);
    const existing = openRouterAccount('My router', 'sk-or-v1-a-different-key');
    const { keychain } = keychainOver(items);
    await moveOpenRouterKey({ state, keychain, logger });
    expect(openRouterAccounts().map((a) => a.id)).toEqual([existing]);
    expect(items.get(OPENROUTER_KEY_ACCOUNT)).toBe(KEY);
    expect(getJudgeConfig(store.db).accountId).toBeNull();
  });

  it.each([
    { name: 'the key write is refused', faults: { failWriteOf: 'account:' } },
    { name: 'the Keychain stores something other than the key', faults: { mangleWrites: true } },
  ])('leaves no account behind and keeps the old item when $name', async ({ faults }) => {
    const items = new Map([[OPENROUTER_KEY_ACCOUNT, KEY]]);
    const { keychain } = keychainOver(items, faults);
    await moveOpenRouterKey({ state, keychain, logger });
    expect(openRouterAccounts()).toEqual([]);
    expect(getJudgeConfig(store.db).accountId).toBeNull();
    expect(items.get(OPENROUTER_KEY_ACCOUNT)).toBe(KEY);
    expect([...items.keys()].filter((k) => k.startsWith('account:'))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain('OLD-ITEM');
  });

  it('keeps everything and creates nothing when the old item cannot be read', async () => {
    const items = new Map([[OPENROUTER_KEY_ACCOUNT, KEY]]);
    const { keychain } = keychainOver(items, { failReadOld: true });
    await moveOpenRouterKey({ state, keychain, logger });
    expect(openRouterAccounts()).toEqual([]);
    expect(items.get(OPENROUTER_KEY_ACCOUNT)).toBe(KEY);
  });

  it('is idempotent after a partial run: a start that crashed before the removal makes no second account', async () => {
    const items = new Map([[OPENROUTER_KEY_ACCOUNT, KEY]]);
    const crashed = keychainOver(items, { failRemove: true });
    await moveOpenRouterKey({ state, keychain: crashed.keychain, logger });
    expect(openRouterAccounts()).toHaveLength(1);
    expect(items.has(OPENROUTER_KEY_ACCOUNT)).toBe(true);
    const next = keychainOver(items);
    await moveOpenRouterKey({ state, keychain: next.keychain, logger });
    expect(openRouterAccounts()).toHaveLength(1);
    expect(items.has(OPENROUTER_KEY_ACCOUNT)).toBe(false);
  });

  it.each([
    { name: 'an account', archived: false },
    { name: 'an archived account', archived: true },
  ])(
    'removes the old item without a second account when $name already holds that key',
    async ({ archived }) => {
      const items = new Map([[OPENROUTER_KEY_ACCOUNT, KEY]]);
      openRouterAccount('OpenRouter', KEY, archived);
      const { keychain } = keychainOver(items);
      await moveOpenRouterKey({ state, keychain, logger });
      expect(openRouterAccounts()).toHaveLength(1);
      expect(items.has(OPENROUTER_KEY_ACCOUNT)).toBe(false);
      expect(getJudgeConfig(store.db).accountId).toBeNull();
    },
  );

  it('makes a new account when the only one is archived and holds another key', async () => {
    const items = new Map([[OPENROUTER_KEY_ACCOUNT, KEY]]);
    openRouterAccount('OpenRouter', 'sk-or-v1-an-older-key', true);
    const { keychain } = keychainOver(items);
    await moveOpenRouterKey({ state, keychain, logger });
    expect(
      openRouterAccounts()
        .map((a) => a.label)
        .sort(),
    ).toEqual(['OpenRouter', 'OpenRouter key']);
  });

  it.each([
    { taken: ['OpenRouter'], expected: 'OpenRouter key' },
    { taken: ['OpenRouter', 'OpenRouter key'], expected: 'OpenRouter 2' },
    { taken: ['OpenRouter', 'OpenRouter key', 'OpenRouter 2'], expected: 'OpenRouter 3' },
  ])('labels the account $expected when $taken are taken', async ({ taken, expected }) => {
    for (const label of taken)
      state.write((ctx) =>
        insertAccount(ctx, { kind: 'claude_subscription', label }, { configDirFor: () => '/x' }),
      );
    const items = new Map([[OPENROUTER_KEY_ACCOUNT, KEY]]);
    const { keychain } = keychainOver(items);
    await moveOpenRouterKey({ state, keychain, logger });
    expect(openRouterAccounts().map((a) => a.label)).toEqual([expected]);
  });

  it('keeps the account decisions already run on', async () => {
    const chosen = openRouterAccount('Chosen', 'sk-or-v1-chosen-key-0001', true);
    store.db.$client.prepare('UPDATE accounts SET archived = 0 WHERE id = ?').run(chosen);
    state.write((ctx) => patchJudgeConfig(ctx, { accountId: chosen }));
    store.db.$client.prepare('UPDATE accounts SET archived = 1 WHERE id = ?').run(chosen);
    const items = new Map([[OPENROUTER_KEY_ACCOUNT, KEY]]);
    const { keychain } = keychainOver(items);
    await moveOpenRouterKey({ state, keychain, logger });
    expect(getJudgeConfig(store.db).accountId).toBe(chosen);
  });

  it('never throws, even when the Keychain is not there', async () => {
    const keychain: Keychain = {
      read: () => {
        throw new KeychainError('locked');
      },
      readAsync: () => Promise.reject(new KeychainError('locked')),
      write: () => undefined,
      remove: () => undefined,
    };
    await expect(moveOpenRouterKey({ state, keychain, logger })).resolves.toBeUndefined();
  });
});
