import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, tempDir, type TempDir } from '../../test/fixtures';
import { createGit } from '../git';
import {
  createLaneSandbox,
  SandboxProfileError,
  type LaneSandbox,
  type LaneSessionInput,
} from './index';

const git = createGit();
const projectId = mintId('Project');

let root: string;
let home: string;
let dataDir: string;
let tmpRoot: string;
let repo: TempDir;
let checkout: string;

function sandbox(overrides: { loginConfigDir?: string | null } = {}): LaneSandbox {
  return createLaneSandbox({
    home,
    dataDir,
    loopback: false,
    loginConfigDir: overrides.loginConfigDir ?? null,
    tmpRoot,
    gitDirs: (path) => git.gitDirs(path),
  });
}

function input(overrides: Partial<LaneSessionInput> = {}): LaneSessionInput {
  return {
    project: { id: projectId, repoPath: repo.path },
    env: { PATH: '/usr/bin:/bin', HOME: home, ANTHROPIC_API_KEY: 'sk-test' },
    rules: [],
    resumeProviderSessionId: null,
    configDir: join(home, '.claude'),
    ...overrides,
  };
}

const writeIn = (base: string, rel: string, text = 'x'): string => {
  const path = join(base, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};

beforeEach(() => {
  // A short root: the lane temp directory's whole path must fit the sandbox's limit.
  root = realpathSync(mkdtempSync('/tmp/sbl-'));
  home = join(root, 'home');
  dataDir = join(home, 'Library', 'Application Support', '10db');
  tmpRoot = join(root, 't');
  mkdirSync(home);
  mkdirSync(tmpRoot);
  repo = createTempRepo();
  checkout = realpathSync(repo.path);
});

afterEach(() => {
  repo.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe('createLaneSandbox', () => {
  it('denies every .env file in the checkout by exact path, skipping node_modules and .git', async () => {
    const env = writeIn(checkout, '.env');
    const local = writeIn(checkout, 'apps/x/.env.local');
    writeIn(checkout, 'node_modules/.env');
    writeIn(checkout, 'node_modules/pkg/.env.production');
    writeIn(checkout, '.git/.env');
    const session = await sandbox().forSession(input());
    try {
      const { denyRead } = session.spec.settings.filesystem;
      expect(denyRead).toEqual(expect.arrayContaining([env, local]));
      expect(denyRead.filter((path) => path.includes('.env'))).toEqual([env, local]);
      expect(session.spec.disallowedTools).toEqual(
        expect.arrayContaining([`Read(/${env})`, `Read(/${local})`]),
      );
      expect(session.spec.disallowedTools.filter((rule) => rule.includes('.env'))).toHaveLength(2);
    } finally {
      session.dispose();
    }
  });

  it("makes the project's stored hosts its allowed domains, and its stored read paths readable", async () => {
    const shared = join(root, 'shared');
    mkdirSync(shared);
    const session = await sandbox().forSession(
      input({
        rules: [
          { toolName: 'SandboxNetworkAccess', pattern: 'registry.npmjs.org' },
          { toolName: 'SandboxNetworkAccess', pattern: 'github.com' },
          { toolName: 'Read', pattern: shared },
          { toolName: 'Bash', pattern: 'pnpm test' },
          { toolName: 'Read', pattern: null },
        ],
      }),
    );
    try {
      expect(session.spec.settings.network.allowedDomains).toEqual([
        'registry.npmjs.org',
        'github.com',
      ]);
      expect(session.spec.settings.filesystem.allowRead).toContain(shared);
      expect(session.fileAccess.readList).toEqual([shared]);
    } finally {
      session.dispose();
    }
  });

  it('leaves out a stored rule the sandbox could not parse, instead of refusing the lane', async () => {
    const session = await sandbox().forSession(
      input({
        rules: [
          { toolName: 'SandboxNetworkAccess', pattern: 'example.com:8443' },
          { toolName: 'Read', pattern: '/opt/data/*' },
          { toolName: 'Read', pattern: 'relative/path' },
        ],
      }),
    );
    try {
      expect(session.spec.settings.network.allowedDomains).toEqual([]);
      expect(session.fileAccess.readList).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it("opens a linked worktree's common dir for reading and its own git dir for writing", async () => {
    const outside = tempDir('lane-worktree');
    try {
      const worktree = join(outside.path, 'wt');
      execFileSync('git', ['-C', checkout, 'worktree', 'add', '-q', '-b', 'wt', worktree], {
        env: isolatedGitEnv(),
        stdio: 'pipe',
      });
      const commonDir = join(checkout, '.git');
      const session = await sandbox().forSession(
        input({ project: { id: projectId, repoPath: worktree } }),
      );
      try {
        const { allowRead, allowWrite } = session.spec.settings.filesystem;
        expect(allowRead).toContain(commonDir);
        expect(allowWrite).toContain(join(commonDir, 'worktrees', 'wt'));
      } finally {
        session.dispose();
      }
    } finally {
      outside.cleanup();
    }
  });

  it('opens no git dir beyond the checkout for an ordinary repository', async () => {
    const session = await sandbox().forSession(input());
    try {
      const { allowRead, allowWrite } = session.spec.settings.filesystem;
      expect(allowRead.filter((path) => path.includes('.git'))).toEqual([]);
      expect(allowWrite.filter((path) => path.includes('.git'))).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it('builds the profile from the real path of a checkout opened through a link', async () => {
    const link = join(root, 'link');
    symlinkSync(checkout, link);
    const env = writeIn(checkout, '.env');
    const session = await sandbox().forSession(
      input({ project: { id: projectId, repoPath: link } }),
    );
    try {
      expect(session.spec.settings.filesystem.allowRead).toContain(checkout);
      expect(session.spec.settings.filesystem.denyRead).toContain(env);
      expect(session.spec.askRules).toContain(`Edit(/${join(checkout, '.mcp.json')})`);
    } finally {
      session.dispose();
    }
  });

  it('gives the session its own temp dir, package caches and an empty global git config', async () => {
    const session = await sandbox().forSession(input());
    try {
      const cache = join(home, 'Library', 'Caches', '10db', 'projects', projectId);
      expect(existsSync(session.tmpDir)).toBe(true);
      expect(dirname(session.tmpDir)).toBe(tmpRoot);
      expect(session.spec.env).toEqual({
        npm_config_cache: join(cache, 'npm'),
        pnpm_config_store_dir: join(cache, 'pnpm-store'),
        pnpm_config_state_dir: join(cache, 'pnpm-state'),
        pnpm_config_cache_dir: join(cache, 'pnpm-cache'),
        CLAUDE_CODE_TMPDIR: session.tmpDir,
        GIT_CONFIG_GLOBAL: '/dev/null',
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      });
      expect(session.spec.settings.filesystem.allowWrite).toEqual(
        expect.arrayContaining([session.tmpDir, cache]),
      );
    } finally {
      session.dispose();
    }
  });

  it("denies the commands every name the session's env carries that is off the allowlist", async () => {
    const session = await sandbox().forSession(input());
    try {
      const denied = session.spec.settings.credentials.envVars.map((entry) => entry.name);
      expect(denied).toContain('ANTHROPIC_API_KEY');
      expect(denied).toContain('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB');
      expect(denied).not.toContain('PATH');
      expect(denied).not.toContain('CLAUDE_CODE_TMPDIR');
      expect(denied).not.toContain('GIT_CONFIG_GLOBAL');
    } finally {
      session.dispose();
    }
  });

  it("asks before an edit or write of the checkout's Claude-protected files and directories", async () => {
    const session = await sandbox().forSession(input());
    try {
      const settings = join(checkout, '.claude', 'settings.json');
      const hooks = join(checkout, '.claude', 'hooks');
      expect(session.spec.askRules).toEqual(
        expect.arrayContaining([
          `Edit(/${settings})`,
          `Write(/${settings})`,
          `Edit(/${hooks}/**)`,
          `Write(/${hooks}/**)`,
        ]),
      );
    } finally {
      session.dispose();
    }
  });

  it("keeps the default account's config dir out of disallowedTools, and lists the other protected reads", async () => {
    const session = await sandbox().forSession(input());
    try {
      const disallowed = session.spec.disallowedTools;
      expect(
        disallowed.filter((rule) => rule.startsWith(`Read(/${join(home, '.claude')})`)),
      ).toEqual([]);
      expect(disallowed).toEqual(
        expect.arrayContaining([
          `Read(/${dataDir})`,
          `Read(/${dataDir}/**)`,
          `Read(/${join(home, '.claude.json')})`,
          `Read(/${join(home, 'Library', 'Keychains')}/**)`,
        ]),
      );
      expect(session.spec.settings.filesystem.denyRead).toContain(join(home, '.claude'));
    } finally {
      session.dispose();
    }
  });

  it('keeps a data dir that holds the config dir out of disallowedTools, and still lists the rest', async () => {
    const configDir = join(dataDir, 'accounts', 'acct-1');
    const session = await sandbox().forSession(input({ configDir }));
    try {
      const disallowed = session.spec.disallowedTools;
      expect(disallowed.filter((rule) => rule.startsWith(`Read(/${dataDir}`))).toEqual([]);
      expect(disallowed).toEqual(
        expect.arrayContaining([
          `Read(/${join(home, '.claude.json')})`,
          `Read(/${join(home, 'Library', 'Keychains')})`,
          `Read(/${join(home, '.claude')}/**)`,
        ]),
      );
      expect(session.fileAccess.configDir).toBe(configDir);
      expect(session.fileAccess.protectedReads).toEqual(
        expect.arrayContaining([dataDir, configDir]),
      );
    } finally {
      session.dispose();
    }
  });

  it("protects the login shell's config dir too", async () => {
    const login = join(home, '.config', 'claude-login');
    const session = await sandbox({ loginConfigDir: login }).forSession(input());
    try {
      expect(session.spec.settings.filesystem.denyRead).toContain(login);
      expect(session.spec.disallowedTools).toContain(`Read(/${login}/**)`);
    } finally {
      session.dispose();
    }
  });

  it('starts at the resumed provider session, and follows the one Claude Code names', async () => {
    const session = await sandbox().forSession(input({ resumeProviderSessionId: 'prov-old' }));
    try {
      const seen = session.fileAccess;
      expect(seen.providerSessionId).toBe('prov-old');
      session.setProviderSession('prov-new');
      expect(seen.providerSessionId).toBe('prov-new');
    } finally {
      session.dispose();
    }
  });

  it('removes the temp dir on dispose, and a second dispose does nothing', async () => {
    const session = await sandbox().forSession(input());
    writeFileSync(join(session.tmpDir, 'scratch'), 'x');
    session.dispose();
    expect(existsSync(session.tmpDir)).toBe(false);
    expect(() => {
      session.dispose();
    }).not.toThrow();
  });

  it('removes the temp dir it made when the profile is refused', async () => {
    // A bracket is a pattern character no sandbox path may hold.
    writeIn(checkout, '.env[1]');
    await expect(sandbox().forSession(input())).rejects.toThrow(SandboxProfileError);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('gives each session of a project its own temp dir', async () => {
    const lanes = sandbox();
    const first = await lanes.forSession(input());
    const second = await lanes.forSession(input({ resumeProviderSessionId: 'prov-1' }));
    try {
      expect(first.tmpDir).not.toBe(second.tmpDir);
    } finally {
      first.dispose();
      second.dispose();
    }
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});
