import { AccountKind, type AccountId, type AccountInput } from '@10db/contracts';
import {
  archiveAccount,
  createTestStore,
  listAccountModels,
  seedAccount,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryKeychain } from '../../test/fixtures';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import {
  createAccountLists,
  parseCatalogue,
  type AccountLists,
  type Catalogue,
} from '../catalogue';
import { ManualClock } from '../clock';
import { createLauncher } from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { capturingLogger } from '../../test/fixtures';
import {
  AccountProbeError,
  FakeAdapter,
  type SeenAccount,
  type SeenModel,
  type AgentAdapter,
} from '../sessions';
import { createListRefresh, type ListRefresh } from './list-refresh';
import { createStartGate } from './start-gate';

let clock: ManualClock;
let store: Store;
let close: () => void;
let state: StateStore;
/** What each account's probe does: the models it lists, or a failure. */
let behaviour: Map<AccountId, SeenModel[] | Partial<SeenAccount> | Error>;
let probed: AccountId[];
let refresh: ListRefresh;
let lists: AccountLists;
/** The catalogue the lists join to; null as when there is none. */
let current: Catalogue | null;
/** While set for an account, its probe answers only once the promise settles. */
let gates: Map<AccountId, Promise<void>>;
let logger: ReturnType<typeof capturingLogger>;

beforeEach(() => {
  clock = new ManualClock(new Date(2026, 10, 6));
  ({ store, close } = createTestStore(() => clock.now()));
  state = createStateStore(store, createEventBus());
  behaviour = new Map();
  gates = new Map();
  current = parseCatalogue(readModelsDevFixture());
  probed = [];
  logger = capturingLogger();
  const base = new FakeAdapter({}).probeSeen;
  // The adapter is the boundary: each account answers as the test staged it, found by its config directory.
  const adapter: Pick<AgentAdapter, 'probeAccount'> = {
    probeAccount: (probe) => {
      const configDir = probe.env['CLAUDE_CONFIG_DIR'] ?? '';
      const id = [...behaviour.keys()].find((accountId) => configDir.includes(accountId));
      if (id === undefined) return Promise.reject(new AccountProbeError('unstaged'));
      probed.push(id);
      const staged = behaviour.get(id);
      if (staged instanceof Error) return Promise.reject(staged);
      const answer = Array.isArray(staged) ? { ...base, models: staged } : { ...base, ...staged };
      const gate = gates.get(id);
      return gate ? gate.then(() => answer) : Promise.resolve(answer);
    },
  };
  lists = createAccountLists({ state, clock, catalogue: () => current, logger });
  refresh = createListRefresh({
    state,
    clock,
    adapter,
    launcher: createLauncher({
      base: { PATH: '/bin' },
      clientApp: 'test',
      keychain: createMemoryKeychain(),
    }),
    startGate: createStartGate(),
    lists,
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

  it('reads one account for a caller that just signed it in', async () => {
    const a = subscription('A');
    const b = subscription('B');
    behaviour.set(a, [OPUS]);
    behaviour.set(b, [HAIKU]);
    await refresh.readOne(a);
    expect(probed).toEqual([a]);
    expect(stored(a)).toEqual(['claude-opus-5-5']);
  });

  it.each<[string, number, number]>([
    ['a list read an hour ago is left alone', 60 * 60_000, 0],
    ['a list read a day ago is read again', 24 * 60 * 60_000, 1],
  ])('at a session start, %s', async (_name, age, probes) => {
    const a = subscription('A');
    behaviour.set(a, [OPUS]);
    await refresh.readOne(a);
    probed.length = 0;
    clock.advance(age);
    await refresh.readIfStale(a);
    expect(probed).toHaveLength(probes);
  });

  it('at a session start, reads an account that has never been read', async () => {
    const a = subscription('A');
    behaviour.set(a, [OPUS]);
    await refresh.readIfStale(a);
    expect(stored(a)).toEqual(['claude-opus-5-5']);
  });

  it('at a session start, does not probe again within the day an account that listed nothing', async () => {
    const a = subscription('A');
    behaviour.set(a, {});
    await refresh.readIfStale(a);
    await refresh.readIfStale(a);
    expect(probed).toEqual([a]);
    clock.advance(24 * 60 * 60_000);
    await refresh.readIfStale(a);
    expect(probed).toEqual([a, a]);
  });

  it('after a failed fetch reads only the accounts whose list is a day old', async () => {
    const a = subscription('A');
    const b = subscription('B');
    behaviour.set(a, [OPUS]);
    behaviour.set(b, [HAIKU]);
    await refresh.readAll();
    clock.advance(23 * 60 * 60_000);
    await refresh.readOne(b);
    probed.length = 0;
    clock.advance(60 * 60_000);
    await refresh.readAll({ staleOnly: true });
    expect(probed).toEqual([a]);
  });

  it('stops between accounts once it is stopped', async () => {
    const a = subscription('A');
    const b = subscription('B');
    behaviour.set(a, [OPUS]);
    behaviour.set(b, [HAIKU]);
    const read = refresh.readAll();
    await refresh.stop();
    await read;
    expect(probed.length).toBeLessThan(2);
    probed.length = 0;
    await refresh.readAll();
    expect(probed).toEqual([]);
  });

  it('counts a probe by another path as a read, whatever it stored', async () => {
    current = null;
    const a = subscription('A');
    behaviour.set(a, [OPUS]);
    lists.record(
      { id: a, kind: AccountKind.ClaudeSubscription },
      { ...new FakeAdapter({}).probeSeen, models: [OPUS] },
    );
    expect(stored(a)).toEqual([]);
    await refresh.readIfStale(a);
    expect(probed).toEqual([]);
    clock.advance(24 * 60 * 60_000);
    await refresh.readIfStale(a);
    expect(probed).toEqual([a]);
  });

  it('reads again, after the running probe, for a sign-in that ended during it', async () => {
    const a = subscription('A');
    behaviour.set(a, [OPUS]);
    let release: () => void = () => undefined;
    gates.set(
      a,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const running = refresh.readAll();
    await vi.waitFor(() => {
      expect(probed).toHaveLength(1);
    });
    // The login finishes now; the probe in flight saw the account before it.
    behaviour.set(a, [HAIKU]);
    const afterLogin = refresh.readOne(a);
    release();
    await Promise.all([running, afterLogin]);
    expect(probed).toEqual([a, a]);
    expect(stored(a)).toEqual(['claude-haiku-5-5']);
  });

  it('waits for a read in flight when it stops', async () => {
    const a = subscription('A');
    behaviour.set(a, [OPUS]);
    let release: () => void = () => undefined;
    gates.set(
      a,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const running = refresh.readAll();
    await vi.waitFor(() => {
      expect(probed).toHaveLength(1);
    });
    let stopped = false;
    const stopping = refresh.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await running;
    expect(stored(a)).toEqual(['claude-opus-5-5']);
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
