import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTempRepo,
  FAKE_SRT,
  isolatedGitEnv,
  SANDBOXED,
  tempDir,
  type TempDir,
} from '../../test/fixtures';
import { projectAtCheckout } from '../delivery';
import { createGit } from '../git';
import {
  createLaneSandbox,
  fileAccessJudge,
  readAccess,
  SandboxProfileError,
  SandboxTempDirError,
  SYSTEM_READS,
  type LaneSandbox,
  type LaneSessionInput,
} from './index';
import type { LaneSandboxDeps } from './lane-sandbox';
import { childListingGrant, listingGrant } from './profile';
import { secretFilesIn } from './project-access';
import { isEqualOrUnder } from './protected-reads';

const git = createGit();
const projectId = mintId('Project');

let root: string;
let home: string;
let dataDir: string;
let tmpRoot: string;
let repo: TempDir;
let checkout: string;

function sandbox(
  overrides: { loginConfigDir?: string | null; gitDirs?: LaneSandboxDeps['gitDirs'] } = {},
): LaneSandbox {
  return createLaneSandbox({
    home,
    dataDir,
    loginConfigDir: overrides.loginConfigDir ?? null,
    tmpRoot,
    gitDirs: overrides.gitDirs ?? ((path) => git.gitDirs(path)),
    // Hermetic: the machine's own install prefixes add no deny.
    systemPrefixes: [],
    runtime: FAKE_SRT,
  });
}

function input(overrides: Partial<LaneSessionInput> = {}): LaneSessionInput {
  return {
    project: { id: projectId, repoPath: repo.path, sandboxLoopback: false },
    env: { PATH: '/usr/bin:/bin', HOME: home, ANTHROPIC_API_KEY: 'sk-test' },
    rules: [],
    resumeProviderSessionId: null,
    configDir: join(home, '.claude'),
    checkouts: [repo.path],
    mcpServers: {},
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

// Their root is a short path under the shared `/tmp`, so a temp dir made in it fits Claude Code's
// 44-byte limit, and no sandbox can write `/tmp`.
describe.skipIf(SANDBOXED)('createLaneSandbox', () => {
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

  it("writes only the lane's own temp dir, never a shared cache or pnpm's shared lock directory", async () => {
    const session = await sandbox().forSession(input());
    try {
      expect(session.spec.settings.filesystem.allowWrite).toEqual([session.tmpDir]);
      expect(session.spec.settings.filesystem.allowWrite.join('\n')).not.toContain(
        'pnpm-store-operation-locks',
      );
    } finally {
      session.dispose();
    }
  });

  it.each([
    ['off', false, undefined],
    ['on', true, true],
  ])("opens localhost when the project's switch is %s", async (_name, sandboxLoopback, binding) => {
    const session = await sandbox().forSession(
      input({ project: { id: projectId, repoPath: repo.path, sandboxLoopback } }),
    );
    try {
      expect(session.spec.settings.network.allowLocalBinding).toBe(binding);
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
          // The broker matches these hosts itself; the profile can't list them.
          { toolName: 'SandboxNetworkAccess', pattern: 'my_service' },
          { toolName: 'SandboxNetworkAccess', pattern: 'fe80::1' },
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

  it("opens a linked worktree's common dir for reading only, and makes its gitfile and both git dirs read-only", async () => {
    const outside = tempDir('lane-worktree');
    try {
      const worktree = join(outside.path, 'wt');
      execFileSync('git', ['-C', checkout, 'worktree', 'add', '-q', '-b', 'wt', worktree], {
        env: isolatedGitEnv(),
        stdio: 'pipe',
      });
      const commonDir = join(checkout, '.git');
      const session = await sandbox().forSession(
        input({ project: { id: projectId, repoPath: worktree, sandboxLoopback: false } }),
      );
      try {
        const { allowRead, allowWrite, denyWrite } = session.spec.settings.filesystem;
        expect(allowRead).toContain(commonDir);
        // The daemon's unsandboxed git follows `commondir`, `gitdir` and `config.worktree` there.
        expect(allowWrite.filter((path) => isEqualOrUnder(path, commonDir))).toEqual([]);
        // Only the daemon writes git state: the worktree's own git dir (HEAD, index, refs), which
        // Claude Code would otherwise open for writing, and the common dir are both denied.
        // The gitfile too: the daemon's git follows it until the checkout is pinned.
        expect(denyWrite).toEqual([
          join(realpathSync(worktree), '.git'),
          join(commonDir, 'worktrees', 'wt'),
          commonDir,
          // The main checkout is another registered project here, read-only as a whole.
          checkout,
        ]);
      } finally {
        session.dispose();
      }
    } finally {
      outside.cleanup();
    }
  });

  it("denies a worktree batch's lane the main checkout, a sibling worktree, its git dir, its gitfile and the common dir, and reads the common dir", async () => {
    const outside = tempDir('lane-worktrees');
    try {
      const add = (name: string) => {
        const path = join(outside.path, name);
        execFileSync('git', ['-C', checkout, 'worktree', 'add', '-q', '-b', name, path], {
          env: isolatedGitEnv(),
          stdio: 'pipe',
        });
        return realpathSync(path);
      };
      const wtA = add('a');
      const wtB = add('b');
      const commonDir = join(checkout, '.git');
      const session = await sandbox().forSession(
        input({
          project: projectAtCheckout(input().project, wtA),
          checkouts: [checkout, wtA, wtB],
        }),
      );
      try {
        const { allowRead, allowWrite, denyWrite } = session.spec.settings.filesystem;
        expect(denyWrite).toEqual(
          expect.arrayContaining([
            checkout,
            wtB,
            join(wtA, '.git'),
            join(commonDir, 'worktrees', 'a'),
            commonDir,
          ]),
        );
        // The checkout itself is writable through the session's cwd, not an allowWrite entry.
        expect(denyWrite).not.toContain(wtA);
        expect(allowWrite).not.toContain(checkout);
        expect(allowWrite).not.toContain(wtB);
        expect(allowRead).toContain(commonDir);
      } finally {
        session.dispose();
      }
    } finally {
      outside.cleanup();
    }
  });

  it('opens no git dir beyond the checkout for an ordinary repository, and makes its own read-only', async () => {
    const session = await sandbox().forSession(input());
    try {
      const { allowRead, allowWrite, denyWrite } = session.spec.settings.filesystem;
      expect(allowRead.filter((path) => path.includes('.git'))).toEqual([]);
      expect(allowWrite.filter((path) => path.includes('.git'))).toEqual([]);
      // The checkout is writable to Claude Code's sandbox; its git dir is not.
      expect(denyWrite).toEqual([join(checkout, '.git')]);
    } finally {
      session.dispose();
    }
  });

  it("makes every registered checkout's git state read-only, a project nested in this one included", async () => {
    // Project B sits inside this checkout, so this lane could otherwise write B's .git; project C is
    // elsewhere, with its git dir apart from its checkout.
    const nested = join(checkout, 'nested');
    execFileSync('git', ['init', '-q', '-b', 'main', nested], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    });
    const elsewhere = tempDir('lane-other-project');
    try {
      const other = join(elsewhere.path, 'c');
      const otherGit = join(elsewhere.path, 'c-git');
      execFileSync('git', ['init', '-q', '-b', 'main', `--separate-git-dir=${otherGit}`, other], {
        env: isolatedGitEnv(),
        stdio: 'pipe',
      });
      const session = await sandbox().forSession(input({ checkouts: [repo.path, nested, other] }));
      try {
        expect(session.spec.settings.filesystem.denyWrite).toEqual([
          join(checkout, '.git'),
          join(checkout, 'nested', '.git'),
          join(realpathSync(other), '.git'),
          realpathSync(otherGit),
          // Another project is read-only as a whole, not only its git state.
          join(checkout, 'nested'),
          realpathSync(other),
        ]);
      } finally {
        session.dispose();
      }
    } finally {
      elsewhere.cleanup();
    }
  });

  it('leaves a project nested in another writable to its own lanes', async () => {
    const nested = join(checkout, 'nested');
    execFileSync('git', ['init', '-q', '-b', 'main', nested], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    });
    const session = await sandbox().forSession(
      input({ project: { ...input().project, repoPath: nested }, checkouts: [repo.path, nested] }),
    );
    try {
      const { denyWrite } = session.spec.settings.filesystem;
      expect(denyWrite).toContain(join(checkout, '.git'));
      expect(denyWrite).not.toContain(checkout);
    } finally {
      session.dispose();
    }
  });

  it('makes the .git gitfile read-only when the git dir it names sits inside the checkout', async () => {
    const separate = tempDir('lane-separate');
    try {
      const work = join(separate.path, 'work');
      execFileSync(
        'git',
        ['init', '-q', '-b', 'main', `--separate-git-dir=${join(work, 'inner-git')}`, work],
        {
          env: isolatedGitEnv(),
          stdio: 'pipe',
        },
      );
      const real = realpathSync(work);
      // The daemon's git refuses to pin such a checkout; the profile still denies its git dir, as it
      // would for one pinned before the rule.
      const inner = join(real, 'inner-git');
      const session = await sandbox({
        gitDirs: () => Promise.resolve({ gitDir: inner, commonDir: inner }),
      }).forSession(
        input({
          project: { id: projectId, repoPath: work, sandboxLoopback: false },
          checkouts: [work],
        }),
      );
      try {
        expect(session.spec.settings.filesystem.denyWrite).toEqual([
          join(real, '.git'),
          join(real, 'inner-git'),
        ]);
      } finally {
        session.dispose();
      }
    } finally {
      separate.cleanup();
    }
  });

  it('builds the profile from the real path of a checkout opened through a link', async () => {
    const link = join(root, 'link');
    symlinkSync(checkout, link);
    const env = writeIn(checkout, '.env');
    const session = await sandbox().forSession(
      input({ project: { id: projectId, repoPath: link, sandboxLoopback: false } }),
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
      // Package caches can hold code a later install runs, so each lane has its own, removed with it.
      const cache = join(session.tmpDir, 'cache');
      expect(existsSync(session.tmpDir)).toBe(true);
      expect(dirname(session.tmpDir)).toBe(tmpRoot);
      // Claude Code and the git it runs itself, outside the sandbox, get no variable that names a
      // path the lane can write: the sandboxed shell sets those from the env file.
      expect(session.spec.env).toEqual({
        MISE_LOG_LEVEL: 'error',
        CLAUDE_CODE_TMPDIR: session.tmpDir,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        TENDB_SANDBOX: '1',
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
        CLAUDE_ENV_FILE: join(
          tmpRoot,
          readdirSync(tmpRoot).find((name) => name.startsWith('10db-env-')) ?? '',
        ),
      });
      expect(session.commandEnv).toEqual({
        npm_config_cache: join(cache, 'npm'),
        npm_config_devdir: join(cache, 'node-gyp'),
        COREPACK_HOME: join(cache, 'corepack'),
        pnpm_config_store_dir: join(cache, 'pnpm-store'),
        pnpm_config_state_dir: join(cache, 'pnpm-state'),
        pnpm_config_cache_dir: join(cache, 'pnpm-cache'),
        CARGO_HOME: join(cache, 'cargo'),
        MISE_CONFIG_DIR: join(session.tmpDir, 'mise'),
        MISE_GLOBAL_CONFIG_FILE: join(session.tmpDir, 'mise', 'config.toml'),
        MISE_SYSTEM_DIR: join(session.tmpDir, 'mise'),
        MISE_SYSTEM_CONFIG_FILE: join(session.tmpDir, 'mise', 'system.toml'),
        MISE_LOG_LEVEL: 'error',
        xcrun_db: join(session.tmpDir, 'xcrun_db'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        XDG_CONFIG_HOME: join(session.tmpDir, 'config'),
        TENDB_SANDBOX: '1',
      });
      expect(session.spec.settings.filesystem.allowWrite).toEqual([session.tmpDir]);
    } finally {
      session.dispose();
    }
    expect(existsSync(join(session.tmpDir, 'cache'))).toBe(false);
  });

  it("gives the lane its own global mise config, holding only the builder's tool versions", async () => {
    writeIn(
      home,
      '.config/mise/config.toml',
      '[tools]\nnode = "26.12.0"\n[env]\nNPM_TOKEN = "secret"\n',
    );
    writeIn(home, '.config/mise/age.txt', 'AGE-SECRET-KEY');
    const session = await sandbox().forSession(input());
    try {
      const config = readFileSync(join(session.tmpDir, 'mise', 'config.toml'), 'utf8');
      expect(config).toContain('node = "26.12.0"');
      expect(config).not.toContain('secret');
      const { allowRead, denyRead } = session.spec.settings.filesystem;
      expect(allowRead.filter((path) => path.startsWith(join(home, '.config')))).toEqual([]);
      expect(denyRead).toContain(join(home, '.config/mise/age.txt'));
    } finally {
      session.dispose();
    }
  });

  it("lets the lane list mise's installs, opening no version whole, and keeps mise's age key and its data dir closed", async () => {
    const mise = join(home, '.local', 'share', 'mise');
    const version = join(mise, 'installs', 'node', '26.12.0');
    writeIn(version, 'bin/node');
    writeIn(version, 'etc/npmrc');
    writeIn(mise, 'downloads/x');
    writeIn(home, '.config/mise/age.txt');
    const session = await sandbox().forSession(input());
    try {
      const { allowRead, denyRead, allowWrite } = session.spec.settings.filesystem;
      expect(allowRead).toEqual(
        expect.arrayContaining([
          listingGrant(join(mise, 'installs')),
          childListingGrant(join(mise, 'installs')),
          join(version, 'bin'),
        ]),
      );
      for (const open of [join(mise, 'installs'), join(mise, 'installs', 'node'), version, mise])
        expect(allowRead).not.toContain(open);
      expect(allowRead.filter((path) => path.startsWith(join(mise, 'downloads')))).toEqual([]);
      expect(allowRead.filter((path) => path.startsWith(join(version, 'etc')))).toEqual([]);
      expect(denyRead).toEqual(
        expect.arrayContaining([join(version, 'etc/npmrc'), join(home, '.config/mise/age.txt')]),
      );
      expect(allowWrite).toEqual([session.tmpDir]);
    } finally {
      session.dispose();
    }
  });

  it("keeps mise's system config from lanes: its dir is denied and mise looks in the lane's own", async () => {
    const session = await sandbox().forSession(input());
    try {
      const { denyRead } = session.spec.settings.filesystem;
      expect(denyRead).toEqual(expect.arrayContaining(['/etc/mise', '/private/etc/mise']));
      expect(readAccess('/etc/mise/config.toml', session.fileAccess).access).toBe('protected');
      expect(existsSync(join(session.tmpDir, 'mise', 'system.toml'))).toBe(false);
    } finally {
      session.dispose();
    }
  });

  it("drops a PATH entry inside any project's checkout, so a lane can't change another's profile", async () => {
    const other = join(home, 'other-repo');
    const bin = join(other, 'node_modules', '.bin');
    writeIn(bin, 'tool');
    const env = { PATH: `${bin}:/usr/bin`, HOME: home };
    const trusted = await sandbox().forSession(input({ env, checkouts: [repo.path] }));
    const untrusted = await sandbox().forSession(input({ env, checkouts: [repo.path, other] }));
    try {
      expect(trusted.spec.settings.filesystem.allowRead).toContain(join(bin, 'tool'));
      expect(untrusted.spec.settings.filesystem.allowRead).not.toContain(join(bin, 'tool'));
    } finally {
      trusted.dispose();
      untrusted.dispose();
    }
  });

  it('gives two sessions of one project two caches, so nothing one writes reaches the other', async () => {
    const first = await sandbox().forSession(input());
    const second = await sandbox().forSession(input());
    try {
      expect(first.commandEnv['CARGO_HOME']).not.toBe(second.commandEnv['CARGO_HOME']);
      expect(first.commandEnv['npm_config_cache']).not.toBe(second.commandEnv['npm_config_cache']);
      expect(first.commandEnv['pnpm_config_store_dir']).not.toBe(
        second.commandEnv['pnpm_config_store_dir'],
      );
    } finally {
      first.dispose();
      second.dispose();
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

  it('gives the session an env file outside every writable path that sets each variable for lane commands', async () => {
    const session = await sandbox().forSession(input());
    try {
      const file = session.spec.env['CLAUDE_ENV_FILE'] ?? '';
      expect(dirname(file)).toBe(tmpRoot);
      // Claude Code strips variables such as CARGO_HOME from a sandboxed command's env; the shell
      // sources this file before each command. Its own `CLAUDE_*` settings are not for commands.
      const out = execFileSync('/bin/sh', [], {
        input: `${readFileSync(file, 'utf8')}exec /usr/bin/env -0\n`,
        env: {},
        encoding: 'utf8',
      });
      const sourced = Object.fromEntries(
        out
          .split('\0')
          .filter((entry) => entry !== '')
          .map((entry) => [
            entry.slice(0, entry.indexOf('=')),
            entry.slice(entry.indexOf('=') + 1),
          ]),
      );
      // Every variable for commands is in the file, those of the session env and those it leaves out.
      const forCommands = Object.entries(session.commandEnv);
      expect(forCommands.map(([name]) => name)).toEqual(
        expect.arrayContaining(['CARGO_HOME', 'xcrun_db', 'MISE_CONFIG_DIR', 'XDG_CONFIG_HOME']),
      );
      for (const [name, value] of Object.entries(session.spec.env).filter(
        ([name]) => !name.startsWith('CLAUDE_'),
      ))
        expect(session.commandEnv[name], name).toBe(value);
      for (const [name, value] of forCommands) expect(sourced[name], name).toBe(value);
      expect(Object.keys(sourced).filter((name) => name.startsWith('CLAUDE_'))).toEqual([]);
      const { allowRead, allowWrite } = session.spec.settings.filesystem;
      expect(allowWrite.filter((path) => isEqualOrUnder(file, path))).toEqual([]);
      expect(allowRead).toContain(file);
      // Claude Code drops the whole sandbox over a pattern it can't parse: the only ones are the
      // exact-match listings, which it accepts (measured), and no write path has one.
      const listings = session.spec.settings.filesystem.allowRead.filter((path) =>
        /[*?[\]{}]/.test(path),
      );
      expect(listings.every((path) => /(\[[^\]]\]|\/\*)$/.test(path))).toBe(true);
      expect(allowWrite.filter((path) => /[*?[\]{}]/.test(path))).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it("keeps every path the lane can write out of Claude Code's own env, and sets them all in the env file", async () => {
    const session = await sandbox().forSession(input());
    try {
      // Claude Code and its git run outside the sandbox with this env. A tool that execs or reads
      // what a variable names would run what the lane wrote: mise's `[env] _.source`, xcrun's cache
      // file, git's and Claude Code's config under XDG_CONFIG_HOME, cargo's `rustc-wrapper`.
      const underTemp = Object.entries(session.spec.env)
        .filter(([, value]) => isEqualOrUnder(value, session.tmpDir))
        .map(([name]) => name);
      expect(underTemp).toEqual(['CLAUDE_CODE_TMPDIR']);
      for (const name of ['xcrun_db', 'XDG_CONFIG_HOME', 'MISE_GLOBAL_CONFIG_FILE', 'CARGO_HOME'])
        expect(Object.keys(session.spec.env), name).not.toContain(name);
      const file = readFileSync(session.spec.env['CLAUDE_ENV_FILE'] ?? '', 'utf8');
      expect(file).toContain(`export xcrun_db='${join(session.tmpDir, 'xcrun_db')}'`);
      expect(file).toContain(`export XDG_CONFIG_HOME='${join(session.tmpDir, 'config')}'`);
    } finally {
      session.dispose();
    }
  });

  it('removes the env file on dispose', async () => {
    const session = await sandbox().forSession(input());
    const file = session.spec.env['CLAUDE_ENV_FILE'] ?? '';
    expect(existsSync(file)).toBe(true);
    session.dispose();
    expect(existsSync(file)).toBe(false);
  });

  it('still removes the temp dir when removing the env file fails, then reports that failure', async () => {
    const session = await sandbox().forSession(input());
    const file = session.spec.env['CLAUDE_ENV_FILE'] ?? '';
    // A directory in the env file's place cannot be removed as a file.
    rmSync(file);
    mkdirSync(file);
    expect(() => {
      session.dispose();
    }).toThrow(new SandboxTempDirError('Could not remove the lane env file'));
    expect(existsSync(session.tmpDir)).toBe(false);
  });

  it('removes the env file and the temp dir when the profile is refused', async () => {
    await expect(
      sandbox().forSession(input({ env: { PATH: '/usr/bin', 'A=B': 'x' } })),
    ).rejects.toThrow(SandboxProfileError);
    expect(readdirSync(tmpRoot)).toEqual([]);
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

  it.each(['.env[1]', '.env]x', '.env}x', '.env{x', '.env\\x', '.env*'])(
    'refuses the lane with a profile error for a secret file named %s, removing the temp dir it made',
    async (name) => {
      // Claude Code drops the whole sandbox, silently, over a pattern character in a path.
      const file = writeIn(checkout, name);
      await expect(sandbox().forSession(input())).rejects.toThrow(SandboxProfileError);
      await expect(sandbox().forSession(input())).rejects.toThrow(file);
      expect(readdirSync(tmpRoot)).toEqual([]);
    },
  );

  it('names the secret file a refusal is about, and why', async () => {
    const file = writeIn(checkout, '.env[1]');
    await expect(sandbox().forSession(input())).rejects.toMatchObject({
      name: 'SandboxProfileError',
      message: `a path can't be used in the sandbox profile: ${file} (glob characters, \`\\\` or a newline)`,
    });
  });

  it.skipIf(process.platform !== 'darwin')(
    'lists a secret file whatever the case of its name, as the file system folds it',
    async () => {
      const upper = writeIn(checkout, 'apps/x/.ENV.local');
      const mixed = writeIn(checkout, '.Env');
      const session = await sandbox().forSession(input());
      try {
        expect(session.spec.settings.filesystem.denyRead).toEqual(
          expect.arrayContaining([upper, mixed]),
        );
      } finally {
        session.dispose();
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'refuses the lane when a directory in the checkout cannot be listed, naming it',
    async () => {
      const locked = join(checkout, 'apps', 'locked');
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      try {
        await expect(sandbox().forSession(input())).rejects.toThrow(
          "a directory in the checkout can't be listed: apps/locked",
        );
        expect(readdirSync(tmpRoot)).toEqual([]);
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  it("refuses the session's file tools on its secret files, by real path, and still searches the checkout", async () => {
    const env = writeIn(checkout, '.env', 'SECRET=1');
    writeIn(checkout, 'src/a.ts');
    symlinkSync(env, join(checkout, 'src', 'innocent'));
    const session = await sandbox().forSession(input());
    try {
      const judge = fileAccessJudge(session.fileAccess);
      const refused = (verdict: 'ok' | { refuse: string }): string =>
        verdict === 'ok' ? '' : verdict.refuse;
      expect(refused(judge.read('Read', { file_path: '.env' }))).toContain('protected path');
      expect(refused(judge.read('Read', { file_path: env }))).toContain('protected path');
      expect(refused(judge.read('Read', { file_path: 'src/innocent' }))).toContain(
        'protected path',
      );
      expect(refused(judge.read('Grep', { path: '.env', pattern: 'SECRET' }))).toContain(
        'protected path',
      );
      expect(refused(judge.read('Glob', { pattern: '.env' }))).toContain('protected path');
      expect(judge.read('Read', { file_path: 'src/a.ts' })).toBe('ok');
      expect(judge.read('Grep', { pattern: 'SECRET' })).toBe('ok');
      expect(judge.read('Grep', { path: checkout, pattern: 'SECRET' })).toBe('ok');
      expect(judge.read('LS', { path: checkout })).toBe('ok');
    } finally {
      session.dispose();
    }
  });

  it('denies a .env link and the file it points to, by both paths, with no card', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const target = writeIn(outside, 'prod.env', 'SECRET=1');
    const link = join(checkout, '.env');
    symlinkSync(target, link);
    const session = await sandbox().forSession(input());
    try {
      const { denyRead } = session.spec.settings.filesystem;
      expect(denyRead).toEqual(expect.arrayContaining([link, target]));
      expect(session.spec.disallowedTools).toEqual(
        expect.arrayContaining([`Read(/${link})`, `Read(/${target})`]),
      );
      const judge = fileAccessJudge(session.fileAccess);
      for (const path of ['.env', link, target]) {
        // The broker refuses a protected read with no card; it cards only `ask`.
        expect(readAccess(path, session.fileAccess).access, path).toBe('protected');
        expect(judge.read('Read', { file_path: path }), path).not.toBe('ok');
      }
    } finally {
      session.dispose();
    }
  });

  it.each<[string, () => string]>([
    ['the checkout', () => '.'],
    ["the checkout's parent", () => '..'],
    ['the root', () => '/'],
    ['a system location', () => '/usr'],
    ['the home holding the toolchains', () => home],
  ])('refuses the lane, naming the target, when a .env link leads to %s', async (_name, target) => {
    symlinkSync(target(), join(checkout, '.env'));
    const refusal = sandbox().forSession(input());
    await expect(refusal).rejects.toThrow(SandboxProfileError);
    await expect(sandbox().forSession(input())).rejects.toThrow(
      /a \.env\* link in the checkout leads to .*, which holds .* every lane command needs/,
    );
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("opens an nvm install's own dirs but never its etc, and denies npm's builtin npmrc", async () => {
    const install = join(home, '.nvm/versions/node/v22.1.0');
    const globalNpmrc = writeIn(install, 'etc/npmrc', '//registry/:_authToken=x');
    writeIn(home, '.nvm/nvm.sh');
    writeIn(install, 'bin/node');
    writeIn(install, 'lib/node_modules/npm/index.js');
    const builtin = join(install, 'lib/node_modules/npm/npmrc');
    const session = await sandbox().forSession(input());
    try {
      const { allowRead, denyRead } = session.spec.settings.filesystem;
      expect(allowRead).toEqual(
        expect.arrayContaining([join(install, 'bin'), join(install, 'lib')]),
      );
      // Every lane reads the system locations. On Linux they hold this fixture's home, as `/tmp` is
      // one; on macOS a home is never inside one.
      const systemReads: readonly string[] = SYSTEM_READS;
      expect(
        allowRead.filter(
          (path) => !systemReads.includes(path) && isEqualOrUnder(globalNpmrc, path),
        ),
      ).toEqual([]);
      expect(denyRead).toContain(builtin);
      expect(session.spec.disallowedTools).toContain(`Read(/${builtin})`);
      expect(readAccess(builtin, session.fileAccess).access).toBe('protected');
    } finally {
      session.dispose();
    }
  });

  it('compares a toolchain read by its real path, refusing a .env link to where it really lives', async () => {
    const real = join(root, 'real-cargo-bin');
    mkdirSync(real);
    mkdirSync(join(home, '.cargo'), { recursive: true });
    symlinkSync(real, join(home, '.cargo', 'bin'));
    symlinkSync(real, join(checkout, '.env'));
    await expect(sandbox().forSession(input())).rejects.toThrow(
      /a \.env\* link in the checkout leads to .*real-cargo-bin, which holds .* every lane command needs/,
    );
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it.each<[string, () => string]>([
    [
      'inside a toolchain',
      () => {
        const plugins = join(home, '.local', 'state', 'mise', 'tracked-configs');
        mkdirSync(plugins, { recursive: true });
        return plugins;
      },
    ],
    ['inside a system location', () => '/usr/share'],
  ])('refuses the lane when a .env link leads to a directory %s', async (_name, target) => {
    symlinkSync(target(), join(checkout, '.env'));
    await expect(sandbox().forSession(input())).rejects.toThrow(
      /a \.env\* link in the checkout leads to .*, a directory inside .* that lane commands read/,
    );
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  // macOS reaches `/private/etc` through the `/etc` link; Linux has no such link.
  it.skipIf(process.platform !== 'darwin')(
    'refuses the lane when a .env link leads to a directory inside a system location reached through a link',
    async () => {
      symlinkSync('/etc/ssh', join(checkout, '.env'));
      await expect(sandbox().forSession(input())).rejects.toThrow(
        /a \.env\* link in the checkout leads to .*, a directory inside .* that lane commands read/,
      );
    },
  );

  it('denies a file inside a system location that a .env link leads to, and starts the lane', async () => {
    symlinkSync('/etc/hosts', join(checkout, '.env'));
    const session = await sandbox().forSession(input());
    try {
      // `/private/etc/hosts` on macOS, `/etc/hosts` on Linux.
      expect(session.spec.settings.filesystem.denyRead).toContain(realpathSync('/etc/hosts'));
    } finally {
      session.dispose();
    }
  });

  // The fixture root must lie outside every system read. On macOS `/tmp` leads to `/private/tmp`,
  // which the system reads leave closed; on Linux `/tmp` is itself a system read, so a link to a
  // directory in it is refused like a link into `/usr/share`.
  it.skipIf(process.platform !== 'darwin')(
    'denies the directory a .env link leads to when it holds nothing the lane needs',
    async () => {
      const outside = join(root, 'envs');
      mkdirSync(outside);
      symlinkSync(outside, join(checkout, '.envs'));
      const session = await sandbox().forSession(input());
      try {
        expect(session.spec.settings.filesystem.denyRead).toContain(outside);
        expect(session.spec.settings.filesystem.allowRead).toContain(checkout);
      } finally {
        session.dispose();
      }
    },
  );

  it.each([
    ['a dangling .env link', (dir: string) => join(dir, 'missing.env')],
    ['a .env link in a loop', (dir: string) => join(dir, '.env')],
  ])('skips %s, which reads nothing', async (_name, targetIn) => {
    symlinkSync(targetIn(checkout), join(checkout, '.env'));
    const session = await sandbox().forSession(input());
    try {
      expect(session.spec.settings.filesystem.denyRead.filter((p) => p.includes('env'))).toEqual(
        [],
      );
      // The machine's own toolchain npmrcs are secret files too; none comes from the checkout.
      expect(
        (session.fileAccess.secretFiles ?? []).filter((path) => isEqualOrUnder(path, checkout)),
      ).toEqual([]);
    } finally {
      session.dispose();
    }
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

describe.skipIf(SANDBOXED)('a lane session’s processes', () => {
  const T = 'Thu Oct 30 12:00:00 2026';
  /** Fake processes: a signal ends the process (or the whole group when negative). */
  let rows: { pid: number; ppid: number; pgid: number; startedAt: string }[];
  /** Working directories and open files, by pid, as `lsof` would report them. */
  let open: Map<number, string[]>;
  let tableFails: boolean;
  function withProcesses(): LaneSandbox {
    return createLaneSandbox({
      home,
      dataDir,
      loginConfigDir: null,
      tmpRoot,
      gitDirs: (path) => git.gitDirs(path),
      systemPrefixes: [],
      runtime: FAKE_SRT,
      processes: {
        table: () =>
          tableFails
            ? Promise.reject(new Error('ps failed'))
            : Promise.resolve(rows.map((r) => ({ ...r }))),
        openPaths: (pids) =>
          Promise.resolve(
            new Map(pids.flatMap((pid) => (open.has(pid) ? [[pid, open.get(pid) ?? []]] : []))),
          ),
        signal: (target) => {
          const before = rows.length;
          rows = rows.filter((r) => (target < 0 ? r.pgid !== -target : r.pid !== target));
          return rows.length < before;
        },
        sleep: () => Promise.resolve(),
        ownPid: 100,
        timers: { setTimeout: () => ({ cancel: () => undefined }) },
      },
    });
  }
  beforeEach(() => {
    rows = [
      { pid: 100, ppid: 1, pgid: 100, startedAt: T },
      { pid: 200, ppid: 100, pgid: 200, startedAt: T },
      { pid: 300, ppid: 200, pgid: 300, startedAt: T },
      { pid: 301, ppid: 300, pgid: 300, startedAt: T },
    ];
    open = new Map();
    tableFails = false;
  });

  it('stops a job its command handed to launchd at once by a path in the temp dir, never by the checkout alone', async () => {
    const session = await withProcesses().forSession(input());
    try {
      rows.push(
        { pid: 600, ppid: 1, pgid: 600, startedAt: T },
        { pid: 610, ppid: 1, pgid: 610, startedAt: T },
        { pid: 700, ppid: 1, pgid: 700, startedAt: T },
        { pid: 710, ppid: 1, pgid: 710, startedAt: T },
      );
      const checkoutDir = join(realpathSync(repo.path), 'src');
      const tmp = realpathSync(session.tmpDir);
      // `pnpm dev &`: works in the checkout, writes to the command's output file in the temp dir.
      open.set(600, [checkoutDir, join(tmp, 'claude-501', 's', 'tasks', 'b1.output')]);
      open.set(610, [tmp]);
      open.set(700, [home]);
      // Another lane's or the builder's job in the same checkout.
      open.set(710, [checkoutDir, join(checkoutDir, 'dev.log')]);
      await session.trackProcesses({ pid: 200, startedAt: T });
      await session.endProcesses();
      expect(rows.map((r) => r.pid)).toEqual([100, 700, 710]);
    } finally {
      session.dispose();
    }
  });

  it('keeps the ledger when the session’s processes could not be stopped, for the next start', async () => {
    const session = await withProcesses().forSession(input());
    await session.trackProcesses({ pid: 200, startedAt: T });
    tableFails = true;
    await expect(session.endProcesses()).rejects.toThrow('ps failed');
    session.dispose();
    const left = readdirSync(tmpRoot).filter((n) => n.startsWith('10db-proc-'));
    expect(left).toHaveLength(1);
    // Named for the daemon that kept it, so a later daemon knows whether its owner still runs.
    expect(left[0]).toMatch(/^10db-proc-100-[0-9a-f]{12}\.json$/);
    const ledger = JSON.parse(readFileSync(join(tmpRoot, left[0] ?? ''), 'utf8')) as {
      members: { pid: number }[];
    };
    expect(ledger.members.map((m) => m.pid).sort()).toEqual([200, 300, 301]);
  });

  it('stops what the session’s commands started when the session ends', async () => {
    const session = await withProcesses().forSession(input());
    try {
      await session.trackProcesses({ pid: 200, startedAt: T });
      await session.endProcesses();
      expect(rows.map((r) => r.pid)).toEqual([100]);
    } finally {
      session.dispose();
    }
  });

  it('keeps a ledger in the temp root while the session lives, and removes it with the rest', async () => {
    const session = await withProcesses().forSession(input());
    expect(readdirSync(tmpRoot).filter((n) => n.startsWith('10db-proc-'))).toHaveLength(1);
    session.dispose();
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('writes the ledger a later daemon uses to stop what a dead one left', async () => {
    const session = await withProcesses().forSession(input());
    try {
      await session.trackProcesses({ pid: 200, startedAt: T });
      const name = readdirSync(tmpRoot).find((n) => n.startsWith('10db-proc-')) ?? '';
      const ledger = JSON.parse(readFileSync(join(tmpRoot, name), 'utf8')) as {
        members: { pid: number }[];
      };
      expect(ledger.members.map((m) => m.pid).sort()).toEqual([200, 300, 301]);
    } finally {
      session.dispose();
    }
  });

  it('does nothing at the end of a session that never started a process', async () => {
    const session = await withProcesses().forSession(input());
    try {
      await session.endProcesses();
      expect(rows).toHaveLength(4);
    } finally {
      session.dispose();
    }
  });
});

// Its checkout comes from the same `/tmp` fixtures.
describe.skipIf(SANDBOXED)('secretFilesIn', () => {
  const failing = (dir: string, code: string) => (path: string) =>
    path === dir
      ? Promise.reject(Object.assign(new Error(`${code}: ${path}`), { code }))
      : Promise.resolve(readdirSync(path, { withFileTypes: true }));

  it.each(['ENOENT', 'ENOTDIR'])(
    'skips a directory that vanished during the walk (%s), which hides nothing',
    async (code) => {
      const kept = writeIn(checkout, 'apps/a/.env');
      writeIn(checkout, 'apps/gone/.env');
      expect(await secretFilesIn(checkout, failing(join(checkout, 'apps', 'gone'), code))).toEqual([
        kept,
      ]);
    },
  );

  it.each(['EACCES', 'EPERM', 'EIO'])(
    'refuses on any other listing error (%s), naming the directory by its relative path',
    async (code) => {
      writeIn(checkout, 'apps/odd/.env');
      await expect(
        secretFilesIn(checkout, failing(join(checkout, 'apps', 'odd'), code)),
      ).rejects.toThrow(
        new SandboxProfileError(
          'secretFiles',
          "a directory in the checkout can't be listed: apps/odd",
        ),
      );
    },
  );

  it('lets the event loop run while it walks', async () => {
    const deepest = writeIn(checkout, 'a/b/c/d/e/.env');
    const order: string[] = [];
    setImmediate(() => order.push('event loop'));
    const found = await secretFilesIn(checkout);
    order.push('walk done');
    expect(found).toEqual([deepest]);
    expect(order).toEqual(['event loop', 'walk done']);
  });
});
