import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, SANDBOXED, type TempDir } from '../../test/fixtures';
import { createGit } from '../git';
import {
  createGateSandbox,
  DOCKER_REFUSAL,
  SandboxProfileError,
  SYSTEM_READS,
  type GateRun,
  type GateRunInput,
  type GateSandbox,
} from './index';
import { isEqualOrUnder } from './protected-reads';

const git = createGit();
const RUNTIME = { node: process.execPath, cli: '/opt/srt/cli.js' };

let root: string;
let home: string;
let dataDir: string;
let tmpRoot: string;
let repo: TempDir;
let checkout: string;

function sandbox(): GateSandbox {
  return createGateSandbox({
    home,
    dataDir,
    loginConfigDir: join(home, '.claude-work'),
    tmpRoot,
    gitDirs: (path) => git.gitDirs(path),
    // Hermetic: the machine's own install prefixes add no deny.
    systemPrefixes: [],
    runtime: RUNTIME,
  });
}

function input(overrides: Partial<GateRunInput> = {}): GateRunInput {
  return {
    project: { repoPath: repo.path, sandboxLoopback: false },
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      LANG: 'en_US.UTF-8',
      GH_TOKEN: 'ghp_canary',
      SSH_AUTH_SOCK: join(home, 'agent.sock'),
      AWS_SECRET_ACCESS_KEY: 'aws-canary',
      ANTHROPIC_API_KEY: 'sk-canary',
      NODE_OPTIONS: '--require /x.js',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      CARGO_HOME: join(home, '.cargo'),
    },
    rules: [],
    checkouts: [repo.path],
    command: 'make gate',
    ...overrides,
  };
}

async function withRun(gateInput: GateRunInput, check: (run: GateRun) => void): Promise<void> {
  const run = await sandbox().forRun(gateInput);
  try {
    check(run);
  } finally {
    run.dispose();
  }
}

/** The settings file the run hands srt, parsed. */
function settingsOf(run: GateRun): {
  network: Record<string, unknown>;
  filesystem: Record<string, string[]>;
} {
  const at = run.args.indexOf('--settings');
  const file = run.args[at + 1] ?? '';
  return JSON.parse(readFileSync(file, 'utf8')) as {
    network: Record<string, unknown>;
    filesystem: Record<string, string[]>;
  };
}

/** Runs the command srt would run inside the sandbox, here without one: its env and shell setup. */
function runInner(run: GateRun): { stdout: string; stderr: string; status: number | null } {
  const inner = run.args[run.args.indexOf('-c') + 1] ?? '';
  const result = spawnSync('/bin/bash', ['-c', inner], {
    cwd: run.cwd,
    env: run.env,
    encoding: 'utf8',
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

beforeEach(() => {
  // A short root: the temp directory's whole path must fit the sandbox's socket path limit.
  root = realpathSync(mkdtempSync('/tmp/sbg-'));
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
describe.skipIf(SANDBOXED)('createGateSandbox', () => {
  it('runs srt with the settings file, in the checkout, from a fixed PATH', async () => {
    await withRun(input(), (run) => {
      expect(run.file).toBe(process.execPath);
      expect(run.args.slice(0, 2)).toEqual([RUNTIME.cli, '--settings']);
      expect(run.args[3]).toBe('-c');
      expect(run.args).toHaveLength(5);
      expect(run.cwd).toBe(checkout);
      // srt's host, the shell it spawns and `env` run outside the sandbox: the env they see names
      // no directory a project writes, and holds nothing of the login env.
      expect(run.env).toEqual({
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: home,
        CLAUDE_CODE_TMPDIR: run.tmpDir,
      });
    });
  });

  it("writes only the checkout and the run's own temp dir, never git state or srt's shared temp", async () => {
    const other = createTempRepo();
    try {
      await withRun(input({ checkouts: [repo.path, other.path] }), (run) => {
        const { filesystem } = settingsOf(run);
        expect(filesystem['allowWrite']).toEqual([run.tmpDir, checkout]);
        const otherCheckout = realpathSync(other.path);
        expect(filesystem['denyWrite']).toEqual(
          expect.arrayContaining([
            join(checkout, '.git'),
            join(otherCheckout, '.git'),
            '/tmp/claude',
            '/private/tmp/claude',
          ]),
        );
        expect(dirname(run.tmpDir)).toBe(tmpRoot);
      });
    } finally {
      other.cleanup();
    }
  });

  it('reads what lanes read: no home, no ~/.ssh, no ~/.config, no data dir, no .env file', async () => {
    const envFile = join(checkout, '.env.local');
    writeFileSync(envFile, 'SECRET=1');
    await withRun(input(), (run) => {
      const { filesystem } = settingsOf(run);
      const allowRead = filesystem['allowRead'] ?? [];
      expect(filesystem['denyRead']).toEqual(
        expect.arrayContaining([
          '/',
          dataDir,
          join(home, '.claude'),
          join(home, '.claude-work'),
          envFile,
        ]),
      );
      expect(allowRead).toEqual(expect.arrayContaining([...SYSTEM_READS, checkout, run.tmpDir]));
      // Home opens only its toolchain dirs, never whole.
      expect(allowRead.filter((path) => isEqualOrUnder(home, path))).toEqual([]);
      for (const closed of [join(home, '.ssh'), join(home, '.config'), dataDir]) {
        const opened = allowRead.filter(
          (path) => isEqualOrUnder(closed, path) || isEqualOrUnder(path, closed),
        );
        expect(opened, closed).toEqual([]);
      }
    });
  });

  it.each([
    ['off', false, undefined],
    ['on', true, true],
  ])(
    "reaches only the project's stored hosts, with localhost when its switch is %s",
    async (_name, sandboxLoopback, binding) => {
      const rules = [
        { toolName: 'SandboxNetworkAccess', pattern: 'registry.npmjs.org' },
        { toolName: 'SandboxNetworkAccess', pattern: 'bad_host.example' },
        { toolName: 'Bash', pattern: 'curl evil.example' },
      ];
      await withRun(input({ project: { repoPath: repo.path, sandboxLoopback }, rules }), (run) => {
        const { network } = settingsOf(run);
        expect(network['allowedDomains']).toEqual(['registry.npmjs.org']);
        expect(network['strictAllowlist']).toBe(true);
        expect(network['allowLocalBinding']).toBe(binding);
        // Unix sockets only in the run's own temp dir: never Docker's or the SSH agent's.
        expect(network['allowUnixSockets']).toEqual([run.tmpDir]);
      });
    },
  );

  it('hands the command the allowlisted env and its own caches, never a credential', async () => {
    await withRun(input(), (run) => {
      const cache = join(run.tmpDir, 'cache');
      expect(run.commandEnv).toEqual({
        PATH: `${join(run.tmpDir, 'bin')}:/usr/bin:/bin`,
        HOME: home,
        LANG: 'en_US.UTF-8',
        TMPDIR: run.tmpDir,
        npm_config_cache: join(cache, 'npm'),
        npm_config_devdir: join(cache, 'node-gyp'),
        COREPACK_HOME: join(cache, 'corepack'),
        pnpm_config_store_dir: join(cache, 'pnpm-store'),
        pnpm_config_state_dir: join(cache, 'pnpm-state'),
        pnpm_config_cache_dir: join(cache, 'pnpm-cache'),
        CARGO_HOME: join(cache, 'cargo'),
        MISE_CONFIG_DIR: join(run.tmpDir, 'mise'),
        MISE_GLOBAL_CONFIG_FILE: join(run.tmpDir, 'mise', 'config.toml'),
        MISE_SYSTEM_DIR: join(run.tmpDir, 'mise'),
        MISE_SYSTEM_CONFIG_FILE: join(run.tmpDir, 'mise', 'system.toml'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        // An empty config home: git and the rest find no config, rather than the builder's.
        XDG_CONFIG_HOME: join(run.tmpDir, 'config'),
        TENDB_SANDBOX: '1',
      });
    });
  });

  it('sets that env inside the sandbox and runs the command with /bin/sh', async () => {
    await withRun(input({ command: 'printf \'%s\\n\' "$0"; env' }), (run) => {
      const { stdout, status } = runInner(run);
      expect(status).toBe(0);
      const lines = stdout.trim().split('\n');
      expect(lines[0]).toBe('/bin/sh');
      const seen = Object.fromEntries(
        lines.slice(1).flatMap((line) => {
          const at = line.indexOf('=');
          return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
        }),
      );
      expect(seen).toMatchObject(run.commandEnv);
      for (const name of [
        'GH_TOKEN',
        'SSH_AUTH_SOCK',
        'AWS_SECRET_ACCESS_KEY',
        'ANTHROPIC_API_KEY',
        'NODE_OPTIONS',
        'DOCKER_HOST',
        'CLAUDE_CODE_TMPDIR',
      ]) {
        expect(seen[name]).toBeUndefined();
      }
    });
  });

  it('keeps quotes and spaces in the command and the env as written', async () => {
    const env = { ...input().env, LANG: "it's a test $HOME `x`" };
    await withRun(input({ env, command: `printf '%s|' "$LANG" 'a b' "c'd"` }), (run) => {
      expect(runInner(run).stdout).toBe(`it's a test $HOME \`x\`|a b|c'd|`);
    });
  });

  it('refuses an env value with a control character, naming the variable but not its value', async () => {
    const env = { ...input().env, LANG: 'secret\nvalue' };
    const pending = sandbox().forRun(input({ env }));
    await expect(pending).rejects.toThrow(SandboxProfileError);
    await expect(sandbox().forRun(input({ env }))).rejects.toThrow(/LANG/);
    await expect(sandbox().forRun(input({ env }))).rejects.not.toThrow(/secret/);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('refuses Docker: its CLI says so, and the run records that the gate wanted it', async () => {
    await withRun(input({ command: 'docker compose up -d' }), (run) => {
      expect(run.dockerRefused()).toBe(false);
      const { stderr, status } = runInner(run);
      expect(status).not.toBe(0);
      expect(stderr).toContain(DOCKER_REFUSAL);
      expect(run.dockerRefused()).toBe(true);
    });
  });

  it('seals the settings file outside the temp dir, and removes both on dispose', async () => {
    const run = await sandbox().forRun(input());
    const file = run.args[2] ?? '';
    expect(dirname(file)).toBe(tmpRoot);
    expect(statSync(file).mode & 0o777).toBe(0o400);
    expect(existsSync(run.tmpDir)).toBe(true);
    run.dispose();
    run.dispose();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(run.tmpDir)).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('leaves nothing behind when the profile is refused', async () => {
    // A .env link to the checkout's own parent would deny what every command needs.
    execFileSync('ln', ['-s', dirname(checkout), join(checkout, '.env')]);
    await expect(sandbox().forRun(input())).rejects.toThrow(SandboxProfileError);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});
