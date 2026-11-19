import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccountKind, mintId, ShapeOrigin } from '@10db/contracts';
import { createTestStore, insertShape, seedProject, shapeConversation } from '@10db/db';
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
import { silentLogger } from '../log';
import { createLaneSandbox, type LaneSandbox } from '../sandbox';
import { createShapePreparer } from './shape-session-tools';

// Shape spec §5.2: a Plan conversation's session gets a read-only lane sandbox, which keeps the
// account's credentials from the commands it runs.

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

function preparer() {
  const real = createLaneSandbox({
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
  const laneSandbox: LaneSandbox = {
    judgeSetup: () => Promise.reject(new Error('a Plan session never previews its setup')),
    forTakeover: () => Promise.reject(new Error('no takeover here')),
    forSession: (given) => real.forSession(given),
  };
  return createShapePreparer({
    state,
    inbox: createInboxService({ state, onParkedAnswer: () => undefined }),
    git: NO_GIT,
    logger: silentLogger,
    laneSandbox,
    protectedPaths: [],
    // The project env: the login shell's, with every billing switch and account secret stripped.
    projectEnv: () => ({ PATH: '/usr/bin:/bin', HOME: homeDir.path }),
    lookup: () => Promise.resolve(['93.184.216.34']),
    builderHome: homeDir.path,
    laneWritableRoots: [join(root, 't')],
    worktreeBase: join(root, 'worktrees'),
    codexLaneTempRoot: '/Users/b/.10db/lanes',
    exportAwsCredentials: () => Promise.resolve({}),
  });
}

describe.skipIf(SANDBOXED)('a Plan conversation’s prepared session', () => {
  it('gives a Plan command none of an account credential, though the session env holds them all', async () => {
    // Auto mode turns Claude Code's own env scrub off, so the sandbox's deny by name is what keeps
    // the session's credentials from a command.
    const names = [...SECRET_VARIABLES, 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'ANTHROPIC_BASE_URL'];
    writeFileSync(join(checkout, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    const project = seedProject(base, { repoPath: checkout });
    const shape = base.write((ctx) =>
      insertShape(ctx, project.id, { title: 'Audit', origin: ShapeOrigin.App }),
    ).value;
    const prepared = await preparer()({
      projectId: project.id,
      shapeId: shape.id,
      conversationId: shapeConversation(state.db, shape.id).id,
      sessionId: mintId('Session'),
      accountKind: AccountKind.AnthropicApiKey,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: homeDir.path,
        ANTHROPIC_API_KEY: SECRET,
        ...Object.fromEntries(names.map((name) => [name, `secret-${name}`])),
      },
      resumeProviderSessionId: null,
      signal: new AbortController().signal,
      observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
    });
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
});
