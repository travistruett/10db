import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  AccountKind,
  Provider,
  mintId,
  ShapeOrigin,
  TRUST_DEFAULTS,
  type ProjectId,
  type ShapeId,
  type AgentAccountKind,
} from '@10db/contracts';
import {
  createTestStore,
  insertShape,
  listInbox,
  recordMcpApproval,
  seedProject,
  shapeConversation,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTempRepo,
  FAKE_SRT,
  homeOutsideTemp,
  SANDBOXED,
  type TempDir,
} from '../../test/fixtures';
import { SECRET_VARIABLES } from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { createInboxService } from '../inbox';
import { approveMcpServer, setAppTrustSwitches } from '../permissions';
import { readYourMcpConfig } from '../session-setup';
import { silentLogger } from '../log';
import { createLaneSandbox, SandboxedMcpServer, type LaneSandbox } from '../sandbox';
import { readRepoMcp } from '../sessions';
import { createShapePreparer } from './shape-session-tools';

// Shape spec §5.2: a Plan conversation's session gets a read-only lane sandbox, the project's
// approved MCP servers as a lane gets them, and the lanes' broker, which cards for the conversation.

const NO_GIT = {
  commitAt: () => Promise.reject(new Error('no repository')),
  folderAt: () => Promise.reject(new Error('no repository')),
  fileAt: () => Promise.resolve({ kind: 'missing' as const }),
};
const SECRET = 'sk-ant-api03-the-accounts-own-key';

let root: string;
/** The builder's home: outside every temp root, which 10db counts as lane-writable. */
let homeDir: TempDir;
let repo: TempDir;
let checkout: string;
let close: () => void;
let state: StateStore;
let base: ReturnType<typeof createTestStore>['store'];
beforeEach(() => {
  root = realpathSync(mkdtempSync('/tmp/sst-'));
  homeDir = homeOutsideTemp('sst');
  mkdirSync(join(root, 't'));
  mkdirSync(join(root, 'run'));
  repo = createTempRepo();
  checkout = realpathSync(repo.path);
  const test = createTestStore();
  base = test.store;
  close = test.close;
  state = createStateStore(test.store, createEventBus());
});
afterEach(() => {
  close();
  repo.cleanup();
  homeDir.cleanup();
  rmSync(root, { recursive: true, force: true });
});

const realSandbox = (): LaneSandbox =>
  createLaneSandbox({
    home: homeDir.path,
    dataDir: join(root, 'data'),
    loginConfigDir: null,
    tmpRoot: join(root, 't'),
    filesRoot: join(root, 'run'),
    gitDirs: (path) => createGit().gitDirs(path),
    systemPrefixes: [],
    runtime: FAKE_SRT,
    worktreeRoot: join(root, 'data', 'worktrees'),
  });

/** A project at the temp repo with `mcp` as its `.mcp.json`, every server but `unapproved` approved. */
function conversation(
  mcp: unknown,
  opts: { unapproved?: readonly string[]; variables?: Readonly<Record<string, string[]>> } = {},
): { projectId: ProjectId; shapeId: ShapeId } {
  writeFileSync(join(checkout, '.mcp.json'), typeof mcp === 'string' ? mcp : JSON.stringify(mcp));
  const project = seedProject(base, { repoPath: checkout });
  const shape = base.write((ctx) =>
    insertShape(ctx, project.id, { title: 'Audit', origin: ShapeOrigin.App }),
  ).value;
  let servers: ReturnType<typeof readRepoMcp>['servers'] = [];
  try {
    servers = readRepoMcp(checkout).servers;
  } catch {
    // A config that doesn't parse has nothing to approve.
  }
  for (const server of servers.filter((s) => !(opts.unapproved ?? []).includes(s.name)))
    base.write((ctx) => {
      recordMcpApproval(ctx, {
        projectId: project.id,
        serverName: server.name,
        configHash: server.review.configHash,
        verdict: 'approved',
        variables: opts.variables?.[server.name] ?? [],
        hosts: [],
        sourceInboxId: null,
      });
    });
  return { projectId: project.id, shapeId: shape.id };
}

/** Where a ChatGPT session's temp dir is made, as the daemon names it. */
const CODEX_LANES = '/Users/b/.10db/lanes';

/** DNS as the tests see it: every name public, but those listed. */
const lookupWith =
  (names: Readonly<Record<string, readonly string[]>> = {}) =>
  (host: string): Promise<readonly string[]> =>
    Promise.resolve(names[host] ?? ['93.184.216.34']);

function preparer(
  given: Pick<LaneSandbox, 'forSession'> = realSandbox(),
  lookup: (host: string) => Promise<readonly string[]> = lookupWith(),
) {
  const laneSandbox: LaneSandbox = {
    judgeSetup: () => Promise.reject(new Error('a Plan session never previews its setup')),
    ...given,
  };
  const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  const profiles: string[] = [];
  const prepare = createShapePreparer({
    state,
    inbox,
    git: NO_GIT,
    logger: silentLogger,
    laneSandbox,
    protectedPaths: [],
    // The project env: the login shell's, with every billing switch and account secret stripped.
    projectEnv: () => ({ PATH: '/usr/bin:/bin', HOME: homeDir.path }),
    lookup,
    builderHome: homeDir.path,
    laneWritableRoots: [join(root, 't')],
    worktreeBase: join(root, 'worktrees'),
    codexLaneTempRoot: CODEX_LANES,
    exportAwsCredentials: (profile) => {
      profiles.push(profile);
      return Promise.resolve({
        AWS_ACCESS_KEY_ID: 'fake-access-key-id',
        AWS_SECRET_ACCESS_KEY: 'fake-secret',
        AWS_CREDENTIAL_EXPIRATION: '2026-11-05T21:00:00Z',
      });
    },
  });
  return { prepare, inbox, profiles };
}

/** The session's launch env, which holds the account's own key. */
const launchEnv = (): Record<string, string> => ({
  PATH: '/usr/bin:/bin',
  HOME: homeDir.path,
  ANTHROPIC_API_KEY: SECRET,
});

const inputFor = (
  owner: { projectId: ProjectId; shapeId: ShapeId },
  accountKind: AgentAccountKind = AccountKind.AnthropicApiKey,
  env: Record<string, string> = launchEnv(),
) => ({
  ...owner,
  conversationId: shapeConversation(state.db, owner.shapeId).id,
  sessionId: mintId('Session'),
  accountKind,
  env,
  resumeProviderSessionId: null,
  signal: new AbortController().signal,
  observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
});

describe.skipIf(SANDBOXED)('a Plan conversation’s prepared session', () => {
  it('runs in a read-only sandbox with the approved servers, and cards its commands for the conversation', async () => {
    const owner = conversation(
      {
        mcpServers: {
          docs: { type: 'http', url: 'https://docs.example.com/mcp' },
          billing: {
            command: 'uvx',
            args: ['awslabs.billing-cost-management-mcp-server@0.0.44'],
            env: { AWS_PROFILE: 'orgtools-prod', AWS_REGION: 'us-east-1' },
          },
          waiting: { type: 'http', url: 'https://waiting.example.com/mcp' },
        },
      },
      { unapproved: ['waiting'] },
    );
    const { prepare, profiles } = preparer();
    const prepared = await prepare(inputFor(owner));
    try {
      expect(prepared.sandbox?.settings.filesystem.denyWrite).toContain(checkout);
      expect(Object.keys(prepared.projectMcpServers).sort()).toEqual(['billing', 'docs']);
      expect(prepared.projectMcpServers['billing']).toBeInstanceOf(SandboxedMcpServer);
      expect(profiles).toEqual(['orgtools-prod']);
      expect(prepared.credentialsExpireAt).toBe('2026-11-05T21:00:00Z');
      expect(prepared.note).toContain('waiting (waiting for the builder');
      expect(prepared.note).toContain('tell the builder');
      expect(listInbox(state.db, { states: ['OPEN'] }).map((c) => c.title)).toEqual([
        `Run the repo's MCP server "waiting"?`,
      ]);
      void prepared
        .canUseTool({
          toolName: 'Bash',
          input: { command: 'pnpm test' },
          toolUseId: 't1',
          escalated: false,
          signal: new AbortController().signal,
        })
        .catch(() => undefined);
      const card = listInbox(state.db, { states: ['OPEN'] }).find((c) => c.title === 'Allow Bash?');
      expect(card?.detail?.['shapeId']).toBe(owner.shapeId);
      expect(card?.targets).toEqual([]);
    } finally {
      await prepared.release();
    }
    expect(existsSync(prepared.sandbox?.env['CLAUDE_CODE_TMPDIR'] ?? '/nonexistent')).toBe(false);
  });

  describe("the builder's own MCP servers", () => {
    function approveYours(approve = true): void {
      writeFileSync(
        join(homeDir.path, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            mine: { type: 'http', url: 'https://mine.example.com/mcp' },
            local: { command: 'npx', args: ['-y', 'pkg'] },
          },
        }),
      );
      const { entries } = readYourMcpConfig({
        home: homeDir.path,
        laneWritable: [],
        plugins: [],
      });
      for (const entry of approve ? entries : []) {
        const hash = entry.configHash;
        if (hash === null) throw new Error('unreadable probe entry');
        state.write((ctx) => {
          approveMcpServer(ctx, entry.key, hash);
        });
      }
    }

    it('a config file that leads into the worktree base leaves its servers out, as the launch judges it', async () => {
      const owner = conversation({ mcpServers: {} });
      const shared = join(root, 'worktrees', 'shared.json');
      mkdirSync(join(root, 'worktrees'));
      writeFileSync(
        shared,
        JSON.stringify({
          mcpServers: { mine: { type: 'http', url: 'https://mine.example.com/mcp' } },
        }),
      );
      symlinkSync(shared, join(homeDir.path, '.claude.json'));
      // Approved, so only where the file leads can leave it out.
      const { entries } = readYourMcpConfig({ home: homeDir.path, laneWritable: [], plugins: [] });
      for (const entry of entries) {
        const hash = entry.configHash;
        if (hash === null) throw new Error('unreadable probe entry');
        state.write((ctx) => {
          approveMcpServer(ctx, entry.key, hash);
        });
      }
      const { prepare } = preparer();
      const prepared = await prepare(inputFor(owner));
      try {
        expect(Object.keys(prepared.yourMcpServers)).toEqual([]);
      } finally {
        await prepared.release();
      }
    });

    it('a Plan session starts with your approved server, and the project’s are unchanged', async () => {
      const owner = conversation({ mcpServers: {} });
      approveYours();
      const { prepare } = preparer();
      const prepared = await prepare(inputFor(owner));
      try {
        expect(Object.keys(prepared.yourMcpServers)).toContain('mine');
        expect(prepared.yourMcpServers['mine']?.connect).toEqual({
          type: 'http',
          url: 'https://mine.example.com/mcp',
          headers: null,
        });
        expect(prepared.projectMcpServers).toEqual({});
        expect(prepared.claudeConnectors).toBe(true);
      } finally {
        await prepared.release();
      }
    });

    it('a Plan session takes no claude.ai connector with the Your MCP servers switch off', async () => {
      const owner = conversation({ mcpServers: {} });
      approveYours();
      state.write((ctx) => {
        setAppTrustSwitches(ctx, { ...TRUST_DEFAULTS, yourMcpServers: false });
      });
      const prepared = await preparer().prepare(inputFor(owner));
      try {
        expect(prepared.claudeConnectors).toBe(false);
      } finally {
        await prepared.release();
      }
    });

    it('a conversation resumed after the approval plans your server again', async () => {
      const owner = conversation({ mcpServers: {} });
      approveYours(false);
      const { prepare } = preparer();
      const before = await prepare(inputFor(owner));
      try {
        expect(Object.keys(before.yourMcpServers)).toEqual([]);
        expect(before.note).toContain('waiting for your approval');
      } finally {
        await before.release();
      }
      approveYours();
      // The engine prepares the session anew on each resume, so the approval is read again.
      const resumed = await prepare({
        ...inputFor(owner),
        resumeProviderSessionId: 'earlier-session',
      });
      try {
        expect(Object.keys(resumed.yourMcpServers)).toContain('mine');
      } finally {
        await resumed.release();
      }
    });

    it('Codex Plan plans the same servers as Claude Plan: your remote one and the stdio one', async () => {
      const owner = conversation({ mcpServers: {} });
      approveYours();
      // The real sandbox, with a Codex temp root it can make under the test's own root.
      const real = realSandbox();
      mkdirSync(join(root, 'codex-lanes'), { mode: 0o700 });
      const { prepare } = preparer({
        forSession: (given) => real.forSession({ ...given, tempRoot: join(root, 'codex-lanes') }),
      });
      const prepared = await prepare(inputFor(owner, AccountKind.CodexSignin));
      try {
        expect(Object.keys(prepared.yourMcpServers).sort()).toEqual(['local', 'mine']);
        expect(prepared.note ?? '').not.toContain('Codex chats and Plan');
      } finally {
        await prepared.release();
      }
    });
  });

  it('gives a Plan command none of an account credential, though the session env holds them all', async () => {
    // Auto mode turns Claude Code's own env scrub off, so the sandbox's deny by name is what keeps
    // the session's credentials from a command.
    const names = [...SECRET_VARIABLES, 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'ANTHROPIC_BASE_URL'];
    const owner = conversation({ mcpServers: {} });
    const { prepare } = preparer();
    const prepared = await prepare(
      inputFor(owner, AccountKind.AnthropicApiKey, {
        ...launchEnv(),
        ...Object.fromEntries(names.map((name) => [name, `secret-${name}`])),
      }),
    );
    try {
      const sandbox = prepared.sandbox;
      if (sandbox === null) throw new Error('A Plan session runs in its sandbox here');
      const denied = new Set(sandbox.settings.credentials.envVars.map((entry) => entry.name));
      const envFile = readFileSync(sandbox.env['CLAUDE_ENV_FILE'] ?? '', 'utf8');
      for (const name of names) {
        expect(denied.has(name), `${name} is denied to Bash`).toBe(true);
        expect(envFile).not.toContain(`secret-${name}`);
      }
    } finally {
      await prepared.release();
    }
  });

  it('starts a Plan session with the instructions, the builder’s skills and their reads', async () => {
    const owner = conversation({ mcpServers: {} });
    writeFileSync(join(checkout, 'AGENTS.md'), '# Rules\n\nUse pnpm.\n');
    const skill = join(homeDir.path, '.claude', 'skills', 's');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: s\ndescription: a skill\n---\n');
    writeFileSync(join(skill, '.env'), 'TOKEN=x');
    const { prepare } = preparer();
    const prepared = await prepare(inputFor(owner));
    try {
      expect(prepared.instructions).toContain('Use pnpm.');
      expect(prepared.setup.loaded.skills).toEqual(['s']);
      expect(prepared.setup.pluginDirs[0]).toMatch(/\/yours$/);
      expect(prepared.setup.secretFiles).toEqual([join(skill, '.env')]);
      expect(prepared.sandbox?.settings.filesystem.allowRead).toContain(
        join(homeDir.path, '.claude', 'skills'),
      );
    } finally {
      await prepared.release();
    }
  });

  it('expands an approved server’s variables from the project env, never the account’s key in the session env', async () => {
    const owner = conversation(
      {
        mcpServers: {
          keyed: {
            type: 'http',
            url: 'https://keyed.example.com/mcp',
            headers: { 'X-Key': '${ANTHROPIC_API_KEY}' },
          },
        },
      },
      { variables: { keyed: ['ANTHROPIC_API_KEY'] } },
    );
    const { prepare } = preparer();
    const prepared = await prepare(inputFor(owner));
    try {
      expect(prepared.projectMcpServers).toEqual({});
      expect(JSON.stringify(prepared.projectMcpServers)).not.toContain(SECRET);
      expect(prepared.note).toContain('keyed');
    } finally {
      await prepared.release();
    }
  });

  it('leaves out a remote server on this Mac or its network, which the sandbox cannot hold', async () => {
    const owner = conversation({
      mcpServers: {
        local: { type: 'http', url: 'http://127.0.0.1:9222/mcp' },
        named: { type: 'http', url: 'http://localhost:9222/mcp' },
        docs: { type: 'http', url: 'https://docs.example.com/mcp' },
      },
    });
    const { prepare } = preparer();
    const prepared = await prepare(inputFor(owner));
    try {
      expect(Object.keys(prepared.projectMcpServers)).toEqual(['docs']);
      expect(prepared.note).toContain('local');
      expect(prepared.note).toContain('named');
    } finally {
      await prepared.release();
    }
  });

  it.each([
    ['resolves to this Mac', ['127.0.0.1']],
    ['resolves to the builder’s network', ['192.168.1.20']],
    ['resolves to a link-local address', ['169.254.169.254']],
    ['resolves to a private IPv6 address', ['fd00::1']],
    ['resolves to one public and one private address', ['93.184.216.34', '10.0.0.5']],
    ['does not resolve', []],
  ] as const)(
    'leaves out a remote server whose public-looking name %s',
    async (_name, addresses) => {
      const owner = conversation({
        mcpServers: {
          rebound: { type: 'http', url: 'https://tools.example.org/mcp' },
          docs: { type: 'http', url: 'https://docs.example.com/mcp' },
        },
      });
      const { prepare } = preparer(realSandbox(), lookupWith({ 'tools.example.org': addresses }));
      const prepared = await prepare(inputFor(owner));
      try {
        expect(Object.keys(prepared.projectMcpServers)).toEqual(['docs']);
        expect(prepared.note).toContain('rebound');
      } finally {
        await prepared.release();
      }
    },
  );

  it('starts with no project server, and says why, when the repo’s MCP config cannot be read', async () => {
    const owner = conversation('{"mcpServers": {');
    const { prepare } = preparer();
    const prepared = await prepare(inputFor(owner));
    try {
      expect(prepared.sandbox).not.toBeNull();
      expect(prepared.projectMcpServers).toEqual({});
      expect(prepared.note).toContain('.mcp.json');
    } finally {
      await prepared.release();
    }
  });

  it('starts with no sandbox, so no command and no project server, when the sandbox cannot be built', async () => {
    const owner = conversation({
      mcpServers: { docs: { type: 'http', url: 'https://d.example/m' } },
    });
    const { prepare } = preparer({
      forSession: () => Promise.reject(new Error('the profile could not be built')),
    });
    const prepared = await prepare(inputFor(owner));
    expect(prepared.sandbox).toBeNull();
    expect(prepared.projectMcpServers).toEqual({});
    expect(prepared.note).toContain('the profile could not be built');
    await prepared.release();
  });
});

describe('the config dir a Plan session’s sandbox is given', () => {
  // Where the account keeps its login, by its kind, as a lane's session reads it (`sessionConfigDir`), and
  // the agent and temp root a lane of that kind gets: a Codex conversation is a Codex thread.
  it.each<[string, AgentAccountKind, string, Provider, string | undefined]>([
    [
      'a Claude kind',
      AccountKind.ClaudeSubscription,
      '/accounts/claude',
      Provider.Claude,
      undefined,
    ],
    ['a Codex kind', AccountKind.CodexSignin, '/accounts/codex', Provider.Codex, CODEX_LANES],
  ])('follows the account of %s', async (_name, kind, expected, provider, tempRoot) => {
    const owner = conversation({ mcpServers: {} });
    const seen: unknown[] = [];
    const { prepare } = preparer({
      forSession: (input) => {
        seen.push({
          configDir: input.configDir,
          provider: input.provider,
          tempRoot: input.tempRoot,
        });
        return Promise.reject(new Error('recorded'));
      },
    });
    const prepared = await prepare(
      inputFor(owner, kind, {
        ...launchEnv(),
        CLAUDE_CONFIG_DIR: '/accounts/claude',
        CODEX_HOME: '/accounts/codex',
      }),
    );
    await prepared.release();
    expect(seen).toEqual([{ configDir: expected, provider, tempRoot }]);
  });
});
