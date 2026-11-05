import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintId, ShapeOrigin, type ProjectId, type ShapeId } from '@10db/contracts';
import { createTestStore, insertShape, listInbox, recordMcpApproval, seedProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, FAKE_SRT, SANDBOXED, type TempDir } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { createInboxService } from '../inbox';
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
let repo: TempDir;
let checkout: string;
let close: () => void;
let state: StateStore;
let base: ReturnType<typeof createTestStore>['store'];
beforeEach(() => {
  root = realpathSync(mkdtempSync('/tmp/sst-'));
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 't'));
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
  rmSync(root, { recursive: true, force: true });
});

const realSandbox = (): LaneSandbox =>
  createLaneSandbox({
    home: join(root, 'home'),
    dataDir: join(root, 'data'),
    loginConfigDir: null,
    tmpRoot: join(root, 't'),
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

function preparer(laneSandbox: LaneSandbox = realSandbox()) {
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
    projectEnv: () => ({ PATH: '/usr/bin:/bin', HOME: join(root, 'home') }),
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
  HOME: join(root, 'home'),
  ANTHROPIC_API_KEY: SECRET,
});

const inputFor = (owner: { projectId: ProjectId; shapeId: ShapeId }) => ({
  ...owner,
  sessionId: mintId('Session'),
  env: launchEnv(),
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
