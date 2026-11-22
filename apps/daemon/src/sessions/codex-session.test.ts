import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountKind, JudgeKind, mintId, Provider } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testPolicy } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import type { LaneSandboxSpec } from '../sandbox';
import { CODEX_HOOK_TIMEOUT_SECONDS, codexHomes } from './codex-home';
import { startCodexSession, type CodexSessionDeps } from './codex-session';
import { fakeAppServer, type FakeAppServer } from './codex-test-support';
import type { SignInState } from './sign-in-check';
import type { LaneSessionSpec, SessionEvent, SessionHandle } from './types';
import { CODEX_VERIFIED_ON } from '../environment';

const THREAD = {
  thread: { id: 'thr-1' },
  model: 'gpt-5.6-sol',
  activePermissionProfile: { id: 'lane' },
};

const FINE = {
  initialize: { userAgent: `codex/${CODEX_VERIFIED_ON}`, codexHome: '/h/codex' },
  'account/read': {
    account: { type: 'chatgpt', email: 'me@example.com', planType: 'pro' },
    requiresOpenaiAuth: true,
  },
  'account/rateLimits/read': {
    rateLimits: { limitId: 'codex', primary: { usedPercent: 12 } },
    accountId: 'ws-1',
  },
  'config/read': {
    layers: [
      { name: { type: 'user' }, disabledReason: null },
      { name: { type: 'project' }, disabledReason: 'the project is not trusted' },
    ],
  },
  // The home's own guard hook, trusted.
  'hooks/list': () => {
    const source = join(codexHome, 'config.toml');
    return {
      data: [
        {
          cwd: '/c',
          hooks: [
            {
              key: `${source}:pre_tool_use:0:0`,
              eventName: 'preToolUse',
              enabled: true,
              currentHash: 'sha256:abc',
              trustStatus: 'trusted',
              sourcePath: source,
              source: 'user',
              timeoutSec: CODEX_HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    };
  },
  'thread/start': THREAD,
  'thread/resume': THREAD,
  'turn/start': { turn: { id: 'turn-1', status: 'inProgress' } },
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

let root: string;
let checkout: string;
let codexHome: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-session-'));
  checkout = join(root, 'checkout');
  codexHome = join(await realpath(root), 'account-home');
  await mkdir(checkout);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function specOf(over: Partial<LaneSessionSpec> = {}): LaneSessionSpec {
  return {
    sessionId: mintId('Session'),
    conversationId: null,
    policy: testPolicy(),
    profile: {
      kind: 'lane',
      workstreamId: mintId('Workstream'),
      sequence: 1,
      allowedTools: [],
    },
    cwd: checkout,
    prompt: 'Do the task',
    model: 'gpt-5.6-sol',
    effort: 'low',
    resumeProviderSessionId: null,
    env: { PATH: '/opt/homebrew/bin:/usr/bin', CODEX_HOME: codexHome },
    account: {
      accountId: mintId('Account'),
      label: 'ChatGPT plan',
      kind: AccountKind.CodexSignin,
      harness: Provider.Codex,
      identity: 'me@example.com · ws-1',
    },
    projectMcpServers: {},
    yourMcpServers: {},
    sandbox,
    mcp: { url: 'http://127.0.0.1:7777/mcp', token: 'tok-secret-1', toolTimeoutMs: 905_000 },
    preToolUse: () => ({ decision: 'allow' }),
    canUseTool: () => Promise.resolve({ behavior: 'allow' }),
    ...over,
  };
}

function depsOf(server: FakeAppServer): CodexSessionDeps {
  return {
    codexPath: '/opt/homebrew/bin/codex',
    logger: silentLogger,
    spawn: server.spawn,
    clock: new ManualClock(),
    socketDir: join(root, 'run'),
    signInCheck: () => Promise.resolve<SignInState>('signed_out'),
    homes: codexHomes(),
  };
}

async function firstEvent(handle: SessionHandle): Promise<SessionEvent | undefined> {
  for await (const event of handle.events) return event;
  return undefined;
}

const methods = (server: FakeAppServer): (string | undefined)[] =>
  server.sent().map((r) => r.method);

describe('a Codex session', () => {
  it('a read-only explore session denies the secret files of the checkout, nested ones too', async () => {
    await mkdir(join(checkout, 'app'));
    await writeFile(join(checkout, '.env'), 'K=1\n');
    await writeFile(join(checkout, 'app', '.env.local'), 'K=2\n');
    const server = fakeAppServer({ ...FINE });
    const handle = startCodexSession(
      {
        ...specOf({ sandbox: null }),
        profile: {
          kind: 'explore',
          judge: JudgeKind.Tendb,
          systemPrompt: 'You are a chat.',
          tools: [],
          allowedTools: [],
          disallowedTools: [],
          agents: {},
        },
      },
      depsOf(server),
    );
    expect(await firstEvent(handle)).toMatchObject({ type: 'started' });
    const started = server.sent().find((r) => r.method === 'thread/start')?.params;
    // The fake's record of what the client sent: the shape is the client's own.
    const config = (started as { config: Record<string, unknown> }).config;
    const lane = (config['permissions'] as Record<string, Record<string, unknown>>)['lane'];
    const filesystem = lane?.['filesystem'] as Record<string, string>;
    const real = await realpath(checkout);
    expect(filesystem[join(real, '.env')]).toBe('deny');
    expect(filesystem[join(real, 'app', '.env.local')]).toBe('deny');
    expect(filesystem[real]).toBe('read');
    await handle.stop();
  });

  it('sends the token nowhere but the child environment', async () => {
    const server = fakeAppServer({ ...FINE });
    const handle = startCodexSession(specOf(), depsOf(server));
    await firstEvent(handle);
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/start');
    });
    expect(JSON.stringify(server.sent())).not.toContain('tok-secret-1');
    await handle.stop();
  });
});
