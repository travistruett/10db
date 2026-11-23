import {
  AccountKind,
  EventType,
  McpSignInChangedData,
  McpSignInState,
  yourMcpServerKey,
  YourMcpSource,
  type AccountId,
  type DaemonEvent,
} from '@10db/contracts';
import { createTestStore, seedAccount, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryKeychain } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createLauncher } from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import type { YourMcpPlan } from '../session-setup';
import { FakeAdapter } from '../sessions';
import { createMcpSignIns, type McpSignIns } from './mcp-sign-ins';

const NO_EXTRAS = {
  enabledTools: null,
  disabledTools: [],
  startupTimeoutSec: null,
  toolTimeoutSec: null,
} as const;
const remote = (name: string, headers: Record<string, string> | null) => ({
  key: yourMcpServerKey(YourMcpSource.ClaudeJson, name),
  claudeName: null,
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

describe('a sign-in', () => {
  const key = LINEAR.key;

  it('never puts a url in an event', async () => {
    const signIns = service();
    await signIns.start({ accountId: codexId, key });
    adapter.completeMcpSignIn('linear', true);
    await vi.waitFor(() => {
      expect(changes()).toContain(McpSignInState.SignedIn);
    });
    expect(JSON.stringify(events)).not.toContain('https://');
  });
});

describe('which servers a sign-in matters for', () => {
  it('leaves out only a server that sends its own Authorization header', async () => {
    const figma = remote('figma', { 'X-Figma-Plugin-Bundle': 'claude-code/1.0' });
    const keyed = remote('keyed', { authorization: 'Bearer secret' });
    plan = planOf({ figma, keyed });
    const listed = await service().list();
    expect(listed.candidates).toEqual([figma.key]);
    expect(listed.rows.map((row) => row.name)).toEqual(['figma']);
  });
});
