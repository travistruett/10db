import {
  AccountKind,
  EventType,
  McpSignInChangedData,
  McpSignInState,
  NotFoundError,
  ConflictError,
  mintId,
  yourMcpServerKey,
  YourMcpSource,
  type AccountId,
  type DaemonEvent,
} from '@10db/contracts';
import { createTestStore, listAccounts, schema, seedAccount, type Store } from '@10db/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryKeychain } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { claudeMcpSignInCommand, createLauncher } from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import type { YourMcpPlan } from '../session-setup';
import { FakeAdapter, McpAuthState, McpSignInError } from '../sessions';
import {
  createMcpSignIns,
  SIGN_IN_STATUS_MS,
  SIGN_IN_STATUS_TTL_MS,
  type McpSignIns,
} from './mcp-sign-ins';

const NO_EXTRAS = {
  enabledTools: null,
  disabledTools: [],
  startupTimeoutSec: null,
  toolTimeoutSec: null,
} as const;
const remote = (name: string, headers: Record<string, string> | null) => ({
  key: yourMcpServerKey(YourMcpSource.ClaudeJson, name),
  type: 'http' as const,
  url: `https://${name}.example/mcp`,
  headers,
  oauth: null,
  codex: NO_EXTRAS,
});
const planOf = (remotes: YourMcpPlan['remote']): YourMcpPlan => ({
  stdio: {},
  remote: remotes,
  leftOut: [],
  connectorsOn: true,
});
const LINEAR = remote('linear', null);

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let adapter: FakeAdapter;
let events: DaemonEvent[];
let plan: YourMcpPlan;
let codexId: AccountId;

function service(base: Record<string, string> = { PATH: '/bin' }): McpSignIns {
  return createMcpSignIns({
    state,
    adapter,
    launcher: createLauncher({
      base,
      clientApp: 'test',
      keychain: createMemoryKeychain(),
    }),
    clock,
    plan: () => plan,
    logger: silentLogger,
  });
}

beforeEach(() => {
  clock = new ManualClock();
  ({ store, close } = createTestStore(() => clock.now()));
  const bus = createEventBus();
  events = [];
  bus.subscribe((event) => events.push(event));
  state = createStateStore(store, bus);
  adapter = new FakeAdapter({});
  plan = planOf({ linear: LINEAR });
  codexId = seedAccount(store, { kind: AccountKind.CodexSignin, label: 'ChatGPT plan' }).id;
  events.length = 0;
});
afterEach(() => {
  close();
});

const changes = () =>
  events
    .filter((e) => e.type === EventType.McpSignInChanged)
    .map((e) => McpSignInChangedData.parse(e.data).state);

describe('the rows', () => {
  it('gives a Codex account and an approved headerless server a not_signed_in row', async () => {
    const { rows } = await service().list();
    expect(rows).toEqual([
      {
        accountId: codexId,
        accountLabel: 'ChatGPT plan',
        key: LINEAR.key,
        name: 'linear',
        state: McpSignInState.NotSignedIn,
        message: null,
      },
    ]);
    expect(adapter.mcpAuthReads).toHaveLength(1);
    expect(Object.keys(adapter.mcpAuthReads[0]?.servers ?? {})).toEqual(['linear']);
  });

  it('reads a signed-in server as signed in', async () => {
    adapter.mcpAuth['linear'] = McpAuthState.SignedIn;
    const { rows } = await service().list();
    expect(rows.map((r) => r.state)).toEqual([McpSignInState.SignedIn]);
  });

  it.each<{ name: string; remotes: YourMcpPlan['remote']; auth?: McpAuthState }>([
    { name: 'a server that sends a header', remotes: { docs: remote('docs', { 'X-Key': 'k' }) } },
    { name: 'no servers at all', remotes: {} },
    { name: 'a server that reads as not OAuth', remotes: { linear: LINEAR }, auth: 'not_oauth' },
  ])('gives no row for $name', async ({ remotes, auth }) => {
    plan = planOf(remotes);
    if (auth !== undefined) adapter.mcpAuth['linear'] = auth;
    expect((await service().list()).rows).toEqual([]);
  });

  it('leaves a Claude account out of the rows', async () => {
    seedAccount(store, { kind: AccountKind.ClaudeSubscription, label: 'Claude plan' });
    expect((await service().list()).rows.map((r) => r.accountId)).toEqual([codexId]);
  });

  it('reads a status that never answers as unknown at SIGN_IN_STATUS_MS, then asks again', async () => {
    adapter.mcpAuthHangs = true;
    const signIns = service();
    const listed = signIns.list();
    await vi.waitFor(() => {
      expect(clock.pendingTimers()).toBeGreaterThan(0);
    });
    clock.advance(SIGN_IN_STATUS_MS);
    expect((await listed).rows).toMatchObject([
      { state: McpSignInState.Unknown, message: "Couldn't read whether it's signed in." },
    ]);
    adapter.mcpAuthHangs = false;
    expect((await signIns.list()).rows.map((r) => r.state)).toEqual([McpSignInState.NotSignedIn]);
  });

  it('reuses a read for a minute, and reads again after a sign-in ends', async () => {
    const signIns = service();
    await signIns.list();
    await signIns.list();
    expect(adapter.mcpAuthReads).toHaveLength(1);
    clock.advance(SIGN_IN_STATUS_TTL_MS);
    await signIns.list();
    expect(adapter.mcpAuthReads).toHaveLength(2);
    await signIns.start({ accountId: codexId, key: LINEAR.key });
    adapter.completeMcpSignIn('linear', true);
    await vi.waitFor(() => {
      expect(changes()).toContain(McpSignInState.SignedIn);
    });
    await signIns.list();
    expect(adapter.mcpAuthReads).toHaveLength(3);
  });
});

describe('a status that cannot be trusted', () => {
  it('reads an adapter failure as unknown with the one line of copy, whatever the adapter said', async () => {
    adapter.mcpAuthError = new McpSignInError('Codex could not start.');
    expect((await service().list()).rows).toMatchObject([
      { state: McpSignInState.Unknown, message: "Couldn't read whether it's signed in." },
    ]);
  });

  it('drops a read that started before a sign-in ended, so the sign-in shows', async () => {
    const signIns = service();
    await signIns.start({ accountId: codexId, key: LINEAR.key });
    clock.advance(SIGN_IN_STATUS_TTL_MS);
    // This read sees the server signed out, as Codex did when it started.
    let release: () => void = () => undefined;
    adapter.mcpAuthGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = signIns.list();
    await vi.waitFor(() => {
      expect(adapter.mcpAuthReads).toHaveLength(2);
    });
    adapter.completeMcpSignIn('linear', true);
    await vi.waitFor(() => {
      expect(changes()).toContain(McpSignInState.SignedIn);
    });
    release();
    await stale;
    adapter.mcpAuthGate = null;
    expect((await signIns.list()).rows.map((r) => r.state)).toEqual([McpSignInState.SignedIn]);
  });

  it('reads again when a server is approved after the last read', async () => {
    const signIns = service();
    await signIns.list();
    plan = planOf({ linear: LINEAR, notion: remote('notion', null) });
    const { rows } = await signIns.list();
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ['linear', McpSignInState.NotSignedIn],
      ['notion', McpSignInState.NotSignedIn],
    ]);
    expect(adapter.mcpAuthReads).toHaveLength(2);
  });
});

describe('a sign-in', () => {
  const key = LINEAR.key;

  it('starts as signing_in with an event, and ends signed_in with another', async () => {
    const signIns = service();
    const started = await signIns.start({ accountId: codexId, key });
    expect(started.rows.map((r) => r.state)).toEqual([McpSignInState.SigningIn]);
    expect(adapter.mcpSignIns).toHaveLength(1);
    expect(adapter.mcpSignIns[0]?.spec.name).toBe('linear');
    expect(changes()).toEqual([McpSignInState.SigningIn]);
    adapter.completeMcpSignIn('linear', true);
    await vi.waitFor(() => {
      expect(changes()).toEqual([McpSignInState.SigningIn, McpSignInState.SignedIn]);
    });
    expect((await signIns.list()).rows.map((r) => r.state)).toEqual([McpSignInState.SignedIn]);
  });

  it('a failure shows failed with its message and an event, and a new start signs in again', async () => {
    const signIns = service();
    await signIns.start({ accountId: codexId, key });
    adapter.completeMcpSignIn('linear', false);
    await vi.waitFor(() => {
      expect(changes()).toEqual([McpSignInState.SigningIn, McpSignInState.Failed]);
    });
    expect((await signIns.list()).rows).toMatchObject([
      {
        state: McpSignInState.Failed,
        message: "The sign-in didn't finish. Try Sign in again.",
      },
    ]);
    const again = await signIns.start({ accountId: codexId, key });
    expect(again.rows.map((r) => r.state)).toEqual([McpSignInState.SigningIn]);
    expect(adapter.mcpSignIns).toHaveLength(2);
  });

  it('a second start opens the page again and never starts a second process', async () => {
    const signIns = service();
    await signIns.start({ accountId: codexId, key });
    await signIns.start({ accountId: codexId, key });
    expect(adapter.mcpSignIns).toHaveLength(1);
    expect(adapter.mcpSignIns[0]?.reopened).toBe(1);
    expect(changes()).toEqual([McpSignInState.SigningIn]);
  });

  it('two starts at once start one process', async () => {
    const signIns = service();
    await Promise.all([
      signIns.start({ accountId: codexId, key }),
      signIns.start({ accountId: codexId, key }),
    ]);
    expect(adapter.mcpSignIns).toHaveLength(1);
  });

  it('stopAll cancels every slot and each sends an event', async () => {
    plan = planOf({ linear: LINEAR, notion: remote('notion', null) });
    const signIns = service();
    await signIns.start({ accountId: codexId, key });
    await signIns.start({ accountId: codexId, key: plan.remote['notion']?.key ?? key });
    await signIns.stopAll();
    expect(adapter.mcpSignIns.map((s) => s.cancelled)).toEqual([true, true]);
    expect(changes().filter((s) => s === McpSignInState.NotSignedIn)).toHaveLength(2);
    expect((await signIns.list()).rows.map((r) => r.state)).not.toContain(McpSignInState.SigningIn);
  });

  it('stopAll leaves a failed slot and its state alone, and cancels a start still under way', async () => {
    plan = planOf({ linear: LINEAR, notion: remote('notion', null) });
    const signIns = service();
    await signIns.start({ accountId: codexId, key });
    adapter.completeMcpSignIn('linear', false);
    await vi.waitFor(() => {
      expect(changes()).toContain(McpSignInState.Failed);
    });
    let release: () => void = () => undefined;
    adapter.mcpSignInGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notionKey = plan.remote['notion']?.key ?? key;
    const starting = signIns.start({ accountId: codexId, key: notionKey });
    await vi.waitFor(() => {
      expect(changes().filter((s) => s === McpSignInState.SigningIn)).toHaveLength(2);
    });
    const stopped = signIns.stopAll();
    release();
    // Shutdown does not return while a start is still to cancel its sign-in.
    await stopped;
    expect(adapter.mcpSignIns.find((s) => s.spec.name === 'notion')?.cancelled).toBe(true);
    await starting;
    // The start that finished after the stop was cancelled, and the failed one was not touched.
    expect(adapter.mcpSignIns.find((s) => s.spec.name === 'notion')?.cancelled).toBe(true);
    expect(changes().filter((s) => s === McpSignInState.NotSignedIn)).toHaveLength(1);
    expect(changes().filter((s) => s === McpSignInState.Failed)).toHaveLength(1);
  });

  it('never puts a url in an event', async () => {
    const signIns = service();
    await signIns.start({ accountId: codexId, key });
    adapter.completeMcpSignIn('linear', true);
    await vi.waitFor(() => {
      expect(changes()).toContain(McpSignInState.SignedIn);
    });
    expect(JSON.stringify(events)).not.toContain('https://');
  });

  it('a new service on the same database has no slot and reads the status again', async () => {
    await service().start({ accountId: codexId, key });
    const fresh = await service().list();
    expect(fresh.rows.map((r) => r.state)).toEqual([McpSignInState.NotSignedIn]);
  });

  it.each<{ name: string; input: () => { accountId: AccountId; key: typeof key }; error: unknown }>(
    [
      {
        name: 'an unknown account',
        input: () => ({ accountId: mintId('Account'), key }),
        error: NotFoundError,
      },
      {
        name: 'an unknown server',
        input: () => ({ accountId: codexId, key: yourMcpServerKey(YourMcpSource.ClaudeJson, 'x') }),
        error: NotFoundError,
      },
      {
        name: 'a Claude account',
        input: () => ({
          accountId: seedAccount(store, { kind: AccountKind.ClaudeSubscription, label: 'Claude' })
            .id,
          key,
        }),
        error: ConflictError,
      },
      {
        name: 'an account with no folder',
        input: () => {
          store.write((ctx) => {
            ctx.tx
              .update(schema.accounts)
              .set({ configDir: null })
              .where(eq(schema.accounts.id, codexId))
              .run();
          });
          return { accountId: codexId, key };
        },
        error: ConflictError,
      },
    ],
  )('refuses $name', async ({ input, error }) => {
    await expect(service().start(input())).rejects.toBeInstanceOf(error);
    expect(adapter.mcpSignIns).toHaveLength(0);
  });
});

describe('the terminal entries', () => {
  it('gives an own-folder plan account its command, once, and the default account none', async () => {
    const own = seedAccount(store, { kind: AccountKind.ClaudeSubscription, label: 'Own plan' });
    const dflt = seedAccount(store, { kind: AccountKind.ClaudeSubscription, label: 'Default' });
    store.write((ctx) => {
      ctx.tx
        .update(schema.accounts)
        .set({ configDir: null })
        .where(eq(schema.accounts.id, dflt.id))
        .run();
    });
    const ownDir = listAccounts(store.db).find((a) => a.id === own.id)?.configDir ?? '';
    expect(ownDir).not.toBe('');
    expect((await service().list()).terminal).toEqual([
      { accountId: own.id, accountLabel: 'Own plan', command: claudeMcpSignInCommand(ownDir) },
    ]);
  });

  it('gives the default account none when the login shell moves its folder, though the folder is set', async () => {
    const dflt = seedAccount(store, { kind: AccountKind.ClaudeSubscription, label: 'Default' });
    store.write((ctx) => {
      ctx.tx
        .update(schema.accounts)
        .set({ configDir: '/h/b/.claude-other' })
        .where(eq(schema.accounts.id, dflt.id))
        .run();
    });
    const signIns = service({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/b/.claude-other' });
    expect((await signIns.list()).terminal).toEqual([]);
  });

  it('gives none when no server can sign in', async () => {
    seedAccount(store, { kind: AccountKind.ClaudeSubscription, label: 'Own plan' });
    plan = planOf({});
    expect(await service().list()).toEqual({ rows: [], terminal: [] });
  });
});
