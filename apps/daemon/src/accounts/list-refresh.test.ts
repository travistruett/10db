import { AccountKind, type AccountId, type AccountInput } from '@10db/contracts';
import {
  archiveAccount,
  createTestStore,
  listAccountModels,
  seedAccount,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryKeychain } from '../../test/fixtures';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import { createAccountLists, parseCatalogue } from '../catalogue';
import { createLauncher } from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { capturingLogger } from '../../test/fixtures';
import {
  AccountProbeError,
  FakeAdapter,
  type SeenAccount,
  type SeenModel,
  type SessionAdapter,
} from '../sessions';
import { createListRefresh, type ListRefresh } from './list-refresh';
import { createStartGate } from './start-gate';

let store: Store;
let close: () => void;
let state: StateStore;
/** What each account's probe does: the models it lists, or a failure. */
let behaviour: Map<AccountId, SeenModel[] | Partial<SeenAccount> | Error>;
let probed: AccountId[];
let refresh: ListRefresh;
let logger: ReturnType<typeof capturingLogger>;

beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  behaviour = new Map();
  probed = [];
  logger = capturingLogger();
  const base = new FakeAdapter({}).probeSeen;
  // The adapter is the boundary: each account answers as the test staged it, found by its config directory.
  const adapter: Pick<SessionAdapter, 'probeAccount'> = {
    probeAccount: (probe) => {
      const configDir = probe.env['CLAUDE_CONFIG_DIR'] ?? '';
      const id = [...behaviour.keys()].find((accountId) => configDir.includes(accountId));
      if (id === undefined) return Promise.reject(new AccountProbeError('unstaged'));
      probed.push(id);
      const staged = behaviour.get(id);
      if (staged instanceof Error) return Promise.reject(staged);
      return Promise.resolve(
        Array.isArray(staged) ? { ...base, models: staged } : { ...base, ...staged },
      );
    },
  };
  refresh = createListRefresh({
    state,
    adapter,
    launcher: createLauncher({
      base: { PATH: '/bin' },
      clientApp: 'test',
      keychain: createMemoryKeychain(),
    }),
    startGate: createStartGate(),
    lists: createAccountLists({
      state,
      catalogue: () => parseCatalogue(readModelsDevFixture()),
      logger,
    }),
    dataDir: '/data',
    logger,
  });
});
afterEach(() => {
  close();
});

const OPUS: SeenModel = { id: 'opus', resolvedId: 'claude-opus-5-5', efforts: ['low'] };
const HAIKU: SeenModel = { id: 'haiku', resolvedId: 'claude-haiku-5-5', efforts: [] };
const subscription = (label: string): AccountId =>
  seedAccount(store, { kind: AccountKind.ClaudeSubscription, label } satisfies AccountInput).id;
const stored = (id: AccountId) => listAccountModels(state.db, id).map((m) => m.model);

describe('reading every account list', () => {
  it('reads each account with the identity probe and stores what it lists', async () => {
    const a = subscription('A');
    const b = subscription('B');
    behaviour.set(a, [OPUS]);
    behaviour.set(b, [HAIKU]);
    await refresh.readAll();
    expect(stored(a)).toEqual(['claude-opus-5-5']);
    expect(stored(b)).toEqual(['claude-haiku-5-5']);
  });

  it("keeps an account's last list when its probe fails, and still reads the others", async () => {
    const a = subscription('A');
    const b = subscription('B');
    behaviour.set(a, [OPUS]);
    behaviour.set(b, [HAIKU]);
    await refresh.readAll();
    behaviour.set(a, new AccountProbeError('Claude Code reported no account within 15 s'));
    behaviour.set(b, [OPUS]);
    await refresh.readAll();
    expect(stored(a)).toEqual(['claude-opus-5-5']);
    expect(stored(b)).toEqual(['claude-opus-5-5']);
    expect(logger.lines().join('\n')).toContain('keeping its last list');
  });

  it('does not store the list of a signed-out account, which still answers', async () => {
    const a = subscription('A');
    behaviour.set(a, { models: [OPUS], email: undefined, subscriptionType: undefined });
    await refresh.readAll();
    expect(stored(a)).toEqual([]);
  });

  it('leaves out an archived account', async () => {
    const archived = subscription('Old');
    behaviour.set(archived, [OPUS]);
    store.write((ctx) => {
      archiveAccount(ctx, archived);
    });
    await refresh.readAll();
    expect(probed).toEqual([]);
  });
});
