import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountKind, mintId } from '@10db/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { testPolicy } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import type { LaneSandboxSpec } from '../sandbox';
import { CODEX_HOOK_TIMEOUT_SECONDS, codexHomes } from './codex-home';
import { startCodexSession } from './codex-session';
import { fakeAppServer, type FakeAppServer } from './codex-test-support';
import { CODEX_VERIFIED_ON } from '../environment';
import type { SessionEvent } from './types';

// A model pick reaches a live Codex thread at its next `turn/start`; a steer carries none.

const THREAD = 'thr-1';
let root: string;
let codexHome: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-model-'));
  codexHome = join(await realpath(root), 'account-home');
  await mkdir(join(root, 'checkout'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ownHooks = () => ({
  data: [
    {
      cwd: '/c',
      hooks: [
        {
          key: `${join(codexHome, 'config.toml')}:pre_tool_use:0:0`,
          eventName: 'preToolUse',
          enabled: true,
          currentHash: 'sha256:abc',
          trustStatus: 'trusted',
          sourcePath: join(codexHome, 'config.toml'),
          source: 'user',
          timeoutSec: CODEX_HOOK_TIMEOUT_SECONDS,
        },
      ],
    },
  ],
});

const thread = {
  thread: { id: THREAD },
  model: 'gpt-5.6-sol',
  activePermissionProfile: { id: 'lane' },
};

const sandbox: LaneSandboxSpec = {
  settings: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    allowAppleEvents: false,
    autoAllowBashIfSandboxed: false,
    filesystem: { denyRead: ['/'], allowRead: [], allowWrite: [], denyWrite: [] },
    network: { allowedDomains: [], allowMachLookup: [], allowUnixSockets: [] },
    credentials: { envVars: [] },
  },
  checkout: '/w/lane',
  env: {},
  shellEnv: { PATH: '/usr/bin', TMPDIR: '/tmp/lane-1' },
  disallowedTools: [],
  askRules: [],
};

function start(): {
  server: FakeAppServer;
  seen: SessionEvent[];
  handle: ReturnType<typeof startCodexSession>;
} {
  const server = fakeAppServer({
    initialize: { userAgent: `codex/${CODEX_VERIFIED_ON}`, codexHome: '/h/codex' },
    'account/read': {
      account: { type: 'chatgpt', email: 'me@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
    },
    'account/rateLimits/read': { rateLimits: { limitId: 'codex' }, accountId: 'ws-1' },
    'config/read': { layers: [{ name: { type: 'user' }, disabledReason: null }] },
    'hooks/list': ownHooks,
    'thread/start': thread,
    'turn/start': { turn: { id: 'turn-1', status: 'inProgress' } },
    'turn/steer': {},
    'turn/interrupt': {},
  });
  const handle = startCodexSession(
    {
      sessionId: mintId('Session'),
      conversationId: null,
      policy: testPolicy(),
      profile: { kind: 'lane', workstreamId: mintId('Workstream'), sequence: 1, allowedTools: [] },
      cwd: join(root, 'checkout'),
      prompt: 'Do the task',
      model: 'gpt-5.6-sol',
      effort: 'low',
      resumeProviderSessionId: null,
      env: { PATH: '/usr/bin', CODEX_HOME: codexHome },
      account: {
        accountId: mintId('Account'),
        label: 'ChatGPT plan',
        kind: AccountKind.CodexSignin,
        identity: 'me@example.com · ws-1',
      },
      projectMcpServers: {},
      sandbox,
      mcp: { url: 'http://127.0.0.1:7777/mcp', token: 'tok', toolTimeoutMs: 905_000 },
      preToolUse: () => ({ decision: 'allow' }),
      canUseTool: () => Promise.resolve({ behavior: 'allow' }),
    },
    {
      codexPath: '/opt/homebrew/bin/codex',
      logger: silentLogger,
      spawn: server.spawn,
      clock: new ManualClock(),
      socketDir: join(root, 'run'),
      signInCheck: () => Promise.resolve('signed_out'),
      homes: codexHomes(),
    },
  );
  const seen: SessionEvent[] = [];
  void (async () => {
    for await (const event of handle.events) seen.push(event);
  })();
  return { server, seen, handle };
}

const sentOf = (server: FakeAppServer, method: string) =>
  server.sent().filter((r) => r.method === method);

it('names the model it is given on the next turn/start, and none on a steer', async () => {
  const { server, seen, handle } = start();
  await vi.waitFor(() => {
    expect(sentOf(server, 'turn/start')).toHaveLength(1);
  });
  server.notify('turn/started', { threadId: THREAD, turn: { id: 'turn-1', status: 'inProgress' } });
  server.notify('turn/completed', {
    threadId: THREAD,
    turn: { id: 'turn-1', status: 'completed' },
  });
  await vi.waitFor(() => {
    expect(seen.some((e) => e.type === 'turn_complete')).toBe(true);
  });
  await handle.setModel('gpt-5.6-terra');
  handle.send('next');
  await vi.waitFor(() => {
    expect(sentOf(server, 'turn/start')).toHaveLength(2);
  });
  expect(sentOf(server, 'turn/start')[1]?.params).toMatchObject({ model: 'gpt-5.6-terra' });
  server.notify('turn/started', { threadId: THREAD, turn: { id: 'turn-2', status: 'inProgress' } });
  handle.send('more');
  await vi.waitFor(() => {
    expect(sentOf(server, 'turn/steer')).toHaveLength(1);
  });
  expect(sentOf(server, 'turn/steer')[0]?.params).not.toHaveProperty('model');
  await handle.stop();
});
