import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, SANDBOXED, type TempDir } from '../../test/fixtures';
import { createGit } from '../git';
import {
  createGateSandbox,
  DOCKER_REFUSAL,
  isLaneTempDirName,
  keepSpotlightOut,
  SandboxProfileError,
  SYSTEM_READS,
  type GateRun,
  type GateRunInput,
  type GateSandbox,
} from './index';
import { sweepPnpmLockDir, UNLOCK_PASSES } from './pnpm-lock-dir';
import { childListingGrant, listingGrant } from './profile';
import { isEqualOrUnder } from './protected-reads';

const git = createGit();
const RUNTIME = { node: process.execPath, cli: '/opt/srt/cli.js' };

let root: string;
let home: string;
let dataDir: string;
let tmpRoot: string;
let filesRoot: string;
let lanesRoot: string;
let pnpmLockDir: string;
let repo: TempDir;
let checkout: string;

/** What the sandbox told the log, by message and fields. */
let warnings: { fields: Record<string, unknown>; message: string }[] = [];
const log = {
  warn: (fields: object, message: string): void => {
    warnings.push({ fields: { ...fields }, message });
  },
};

function sandbox(): GateSandbox {
  return createGateSandbox({
    home,
    dataDir,
    loginConfigDir: join(home, '.claude-work'),
    tmpRoot,
    filesRoot,
    codexLaneTempRoot: lanesRoot,
    pnpmLockDir,
    gitDirs: (path) => git.gitDirs(path),
    // Hermetic: the machine's own install prefixes add no deny.
    systemPrefixes: [],
    runtime: RUNTIME,
    log,
  });
}

function input(overrides: Partial<GateRunInput> = {}): GateRunInput {
  return {
    project: { repoPath: repo.path, sandboxLoopback: false, sandboxDocker: false },
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
    await run.dispose();
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
function runInner(run: GateRun): {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
} {
  const inner = run.args[run.args.indexOf('-c') + 1] ?? '';
  const result = spawnSync('/bin/bash', ['-c', inner], {
    cwd: run.cwd,
    env: run.env,
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    signal: result.signal,
  };
}

beforeEach(() => {
  warnings = [];
  // A short root: the temp directory's whole path must fit the sandbox's socket path limit.
  root = realpathSync(mkdtempSync('/tmp/sbg-'));
  home = join(root, 'home');
  dataDir = join(home, 'Library', 'Application Support', '10db');
  tmpRoot = join(root, 't');
  filesRoot = join(root, 'run');
  lanesRoot = join(root, 'lanes');
  pnpmLockDir = join(root, 'pnpm-locks');
  mkdirSync(home);
  mkdirSync(tmpRoot);
  mkdirSync(filesRoot);
  mkdirSync(lanesRoot);
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
        SRT_DEBUG: '1',
      });
    });
  });

  it('says how many lines the command line srt echoes in its debug log takes', async () => {
    // An env value can't hold a newline (the sandbox refuses it); a gate command can.
    await withRun(input({ command: 'make gate\nmake check\nmake e2e' }), (run) => {
      const inner = run.args[run.args.indexOf('-c') + 1] ?? '';
      expect(inner.split('\n')).toHaveLength(3);
      expect(run.commandLines).toBe(3);
    });
  });

  it("writes only the checkout and the run's own temp dir, never git state or srt's shared temp", async () => {
    const other = createTempRepo();
    try {
      // A read-list entry over every sandbox root opens none of them.
      const rules = [{ toolName: 'Read', pattern: root }];
      await withRun(input({ checkouts: [repo.path, other.path], rules }), (run) => {
        const { filesystem } = settingsOf(run);
        expect(filesystem['allowWrite']).toEqual([run.tmpDir, checkout]);
        expect(filesystem['denyRead']).toEqual(
          expect.arrayContaining([tmpRoot, lanesRoot, filesRoot]),
        );
        expect(filesystem['allowRead']).toContain(run.tmpDir);
        expect(filesystem['allowRead']).not.toContain(root);
        // The run's own settings file is read by srt before the sandbox starts, never inside it.
        const settingsFile = run.args[run.args.indexOf('--settings') + 1] ?? '';
        expect(
          (filesystem['allowRead'] ?? []).filter((open) => isEqualOrUnder(settingsFile, open)),
        ).toEqual([]);
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

  it('makes another project read-only as a whole, one nested in this checkout included', async () => {
    const nested = join(checkout, 'nested');
    execFileSync('git', ['init', '-q', '-b', 'main', nested], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    });
    await withRun(input({ checkouts: [repo.path, nested] }), (run) => {
      const { filesystem } = settingsOf(run);
      expect(filesystem['allowWrite']).toEqual([run.tmpDir, checkout]);
      expect(filesystem['denyWrite']).toEqual(
        expect.arrayContaining([nested, join(nested, '.git')]),
      );
    });
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
      // A built-in read that holds a sandbox root is left out (on Linux the roots lie under `/tmp`).
      const builtIn = SYSTEM_READS.filter(
        (path) => ![tmpRoot, lanesRoot, filesRoot].some((held) => isEqualOrUnder(held, path)),
      );
      expect(allowRead).toEqual(expect.arrayContaining([...builtIn, checkout, run.tmpDir]));
      // This home lies in the test's temp dir, which on Linux is under the system read `/tmp` (macOS
      // resolves it to `/private/tmp`). A real home never is, so only the rest must keep it closed.
      const systemCover: readonly string[] = SYSTEM_READS.filter((path) =>
        isEqualOrUnder(home, path),
      );
      const profileReads = allowRead.filter((path) => !systemCover.includes(path));
      // Home opens only its toolchain dirs, never whole.
      expect(profileReads.filter((path) => isEqualOrUnder(home, path))).toEqual([]);
      for (const closed of [join(home, '.ssh'), join(home, '.config'), dataDir]) {
        const opened = profileReads.filter(
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
      await withRun(
        input({ project: { repoPath: repo.path, sandboxLoopback, sandboxDocker: false }, rules }),
        (run) => {
          const { network } = settingsOf(run);
          expect(network['allowedDomains']).toEqual(['registry.npmjs.org']);
          expect(network['strictAllowlist']).toBe(true);
          expect(network['allowLocalBinding']).toBe(binding);
          // Unix sockets only in the run's own temp dir: never Docker's or the SSH agent's.
          expect(network['allowUnixSockets']).toEqual([run.tmpDir]);
        },
      );
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
        UV_CACHE_DIR: join(cache, 'uv'),
        UV_TOOL_DIR: join(cache, 'uv-tools'),
        UV_PYTHON_INSTALL_DIR: join(cache, 'uv-python'),
        MISE_CONFIG_DIR: join(run.tmpDir, 'mise'),
        MISE_GLOBAL_CONFIG_FILE: join(run.tmpDir, 'mise', 'config.toml'),
        MISE_SYSTEM_DIR: join(run.tmpDir, 'mise'),
        MISE_SYSTEM_CONFIG_FILE: join(run.tmpDir, 'mise', 'system.toml'),
        MISE_LOG_LEVEL: 'error',
        xcrun_db: join(run.tmpDir, 'xcrun_db'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        // An empty config home: git and the rest find no config, rather than the builder's.
        XDG_CONFIG_HOME: join(run.tmpDir, 'config'),
        TENDB_SANDBOX: '1',
      });
    });
  });

  it("lets the gate list mise's installs, opening no version whole, and keeps mise's age key and its data dir closed", async () => {
    const mise = join(home, '.local', 'share', 'mise');
    const version = join(mise, 'installs', 'node', '26.12.0');
    for (const file of [
      join(version, 'bin', 'node'),
      join(version, 'etc', 'npmrc'),
      join(mise, 'downloads', 'x'),
      join(home, '.config', 'mise', 'age.txt'),
    ]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'x');
    }
    await withRun(input(), (run) => {
      const { filesystem } = settingsOf(run);
      const allowRead = filesystem['allowRead'] ?? [];
      const denyRead = filesystem['denyRead'] ?? [];
      const allowWrite = filesystem['allowWrite'] ?? [];
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
        expect.arrayContaining([
          join(version, 'etc', 'npmrc'),
          join(home, '.config', 'mise', 'age.txt'),
        ]),
      );
      // Nothing under the toolchains is writable: mise's state and installs stay read-only.
      expect(allowWrite.some((path) => isEqualOrUnder(path, home))).toBe(false);
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
        'SRT_DEBUG',
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
    expect(readdirSync(filesRoot)).toEqual([]);
  });

  // srt exits 0 when its own child dies by TERM or INT, so that child must never be the command.
  it.each([
    ['TERM', 143],
    ['INT', 130],
  ])('exits non-zero, never by signal, when the command dies by SIG%s', async (signal, code) => {
    await withRun(input({ command: `echo partial; kill -${signal} $$` }), (run) => {
      const result = runInner(run);
      expect(result.stdout).toBe('partial\n');
      expect(result.signal).toBeNull();
      expect(result.status).toBe(code);
    });
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

  describe('with the project’s Docker switch on', () => {
    const docker = (): GateRunInput =>
      input({
        project: { repoPath: repo.path, sandboxLoopback: false, sandboxDocker: true },
        command: 'docker compose exec -T backend true',
      });

    it('puts no refusing docker on the PATH, so the CLI runs and its status decides', async () => {
      await withRun(docker(), (run) => {
        const { stderr } = runInner(run);
        expect(stderr).not.toContain(DOCKER_REFUSAL);
        expect(run.dockerRefused()).toBe(false);
        expect(existsSync(join(run.tmpDir, 'bin', 'docker'))).toBe(false);
      });
    });

    it('opens the engine sockets and what the CLI reads, and passes the names that find the engine', async () => {
      await withRun(
        { ...docker(), env: { ...input().env, COMPOSE_PROJECT_NAME: 'amps', DOCKER_CONFIG: '/x' } },
        (run) => {
          const settings = settingsOf(run);
          expect(settings.network['allowUnixSockets']).toEqual(
            expect.arrayContaining([run.tmpDir, '/var/run/docker.sock']),
          );
          expect(settings.filesystem['allowRead']).toEqual(
            expect.arrayContaining([join(home, '.docker', 'cli-plugins')]),
          );
          expect(run.commandEnv['DOCKER_HOST']).toBe('unix:///var/run/docker.sock');
          expect(run.commandEnv['COMPOSE_PROJECT_NAME']).toBe('amps');
          // The config dir names plugins the CLI would run: never passed.
          expect(run.commandEnv['DOCKER_CONFIG']).toBeUndefined();
        },
      );
    });

    it('with the switch off, opens no socket and passes no Docker name', async () => {
      await withRun(input(), (run) => {
        expect(settingsOf(run).network['allowUnixSockets']).toEqual([run.tmpDir]);
        expect(run.commandEnv['DOCKER_HOST']).toBeUndefined();
      });
    });
  });

  it('seals the settings file in the files root, outside every temp dir, and removes both on dispose', async () => {
    const run = await sandbox().forRun(input());
    const file = run.args[2] ?? '';
    expect(dirname(file)).toBe(filesRoot);
    expect(dirname(run.tmpDir)).toBe(tmpRoot);
    expect(statSync(file).mode & 0o777).toBe(0o400);
    expect(existsSync(run.tmpDir)).toBe(true);
    await run.dispose();
    await run.dispose();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(run.tmpDir)).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(readdirSync(filesRoot)).toEqual([]);
  });

  it.each([
    ['cli', 'in the checkout', (): Partial<typeof RUNTIME> => ({ cli: join(checkout, 'srt.mjs') })],
    [
      'cli',
      'linked from outside into the checkout',
      (): Partial<typeof RUNTIME> => {
        writeFileSync(join(checkout, 'srt.mjs'), '');
        symlinkSync(join(checkout, 'srt.mjs'), join(root, 'srt.mjs'));
        return { cli: join(root, 'srt.mjs') };
      },
    ],
    [
      'node',
      'linked from the temp root',
      (): Partial<typeof RUNTIME> => {
        symlinkSync(process.execPath, join(tmpRoot, 'node'));
        return { node: join(tmpRoot, 'node') };
      },
    ],
    [
      'node',
      'linked from another root lanes write',
      (): Partial<typeof RUNTIME> => {
        symlinkSync(process.execPath, join(lanesRoot, 'node'));
        return { node: join(lanesRoot, 'node') };
      },
    ],
  ])("refuses srt's %s %s: a project could swap it", async (_what, _where, place) => {
    const runtime = { ...RUNTIME, ...place() };
    const pending = createGateSandbox({
      home,
      dataDir,
      loginConfigDir: null,
      tmpRoot,
      filesRoot,
      laneWritableRoots: [lanesRoot],
      gitDirs: (path) => git.gitDirs(path),
      systemPrefixes: [],
      runtime,
      log,
    }).forRun(input());
    await expect(pending).rejects.toThrow(SandboxProfileError);
    // No temp dir is left beside the link a row plants there.
    expect(readdirSync(tmpRoot).filter(isLaneTempDirName)).toEqual([]);
    expect(readdirSync(filesRoot)).toEqual([]);
  });

  it('removes the temp dir without blocking the event loop', async () => {
    const run = await sandbox().forRun(input());
    // A tree a gate left unwritable: removal has to walk and chmod it.
    const deep = join(run.tmpDir, 'cache', 'a', 'b');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'f'), 'x');
    chmodSync(deep, 0o500);
    let ticked = false;
    const disposing = run.dispose();
    setImmediate(() => {
      ticked = true;
    });
    await disposing;
    expect(ticked).toBe(true);
    expect(existsSync(run.tmpDir)).toBe(false);
  });

  it('leaves nothing behind when the profile is refused', async () => {
    // A .env link to the checkout's own parent would deny what every command needs.
    execFileSync('ln', ['-s', dirname(checkout), join(checkout, '.env')]);
    await expect(sandbox().forRun(input())).rejects.toThrow(SandboxProfileError);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(readdirSync(filesRoot)).toEqual([]);
  });
  it('is never built without a log, so whatever a sweep leaves is told', () => {
    const build = (): GateSandbox =>
      // @ts-expect-error `log` is required: the daemon and `scripts/sandboxed-gate.ts` pass theirs.
      createGateSandbox({
        home,
        dataDir,
        loginConfigDir: null,
        tmpRoot,
        filesRoot,
        gitDirs: (path) => git.gitDirs(path),
        runtime: RUNTIME,
      });
    expect(build).toBeTypeOf('function');
  });

  describe('a run that installs packages', () => {
    it("opens pnpm's store lock directory, which pnpm puts in the system temp dir whatever TMPDIR says", async () => {
      await withRun(input({ packageInstall: true }), (run) => {
        const { filesystem } = settingsOf(run);
        expect(filesystem['allowWrite']).toEqual([run.tmpDir, checkout, pnpmLockDir]);
        // pnpm opens its lock files for reading and writing.
        expect(filesystem['allowRead']).toContain(pnpmLockDir);
        expect(lstatSync(pnpmLockDir).mode & 0o777).toBe(0o700);
      });
    });

    it('leaves the lock directory closed, and alone, for any other run', async () => {
      await withRun(input(), (run) => {
        const { filesystem } = settingsOf(run);
        expect(filesystem['allowWrite']).toEqual([run.tmpDir, checkout]);
        expect(filesystem['allowRead']).not.toContain(pnpmLockDir);
        expect(existsSync(pnpmLockDir)).toBe(false);
      });
    });

    it('removes the lock directory and all it holds after the run, without following a link in it', async () => {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'keep'), 'k');
      const run = await sandbox().forRun(input({ packageInstall: true }));
      writeFileSync(join(pnpmLockDir, 'all-stores.lock'), '');
      symlinkSync(outside, join(pnpmLockDir, 'abc.lock'));
      mkdirSync(join(pnpmLockDir, 'dir.lock'));
      const target = join(root, 'target');
      writeFileSync(target, 'x');
      execFileSync('ln', [target, join(pnpmLockDir, 'hard.lock')]);
      // A directory a run planted, with a file, a link out and a locked directory in it.
      mkdirSync(join(pnpmLockDir, 'planted', 'locked'), { recursive: true });
      writeFileSync(join(pnpmLockDir, 'planted', 'f'), 'x');
      symlinkSync(outside, join(pnpmLockDir, 'planted', 'out'));
      chmodSync(join(pnpmLockDir, 'planted', 'locked'), 0o000);
      await run.dispose();
      expect(existsSync(pnpmLockDir)).toBe(false);
      expect(readdirSync(root).filter((name) => name.includes('sweep'))).toEqual([]);
      expect(readdirSync(tmpRoot)).toEqual([]);
      expect(readdirSync(filesRoot)).toEqual([]);
      expect(readdirSync(outside)).toEqual(['keep']);
      expect(readFileSync(target, 'utf8')).toBe('x');
    });

    it('starts from a fresh directory whatever an earlier run or crash left at the path', async () => {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'keep'), 'k');
      symlinkSync(outside, pnpmLockDir);
      const run = await sandbox().forRun(input({ packageInstall: true }));
      expect(lstatSync(pnpmLockDir).isDirectory()).toBe(true);
      expect(readdirSync(pnpmLockDir)).toEqual([]);
      await run.dispose();
      expect(readdirSync(outside)).toEqual(['keep']);
    });

    it('unlinks a lock directory the run replaced with a link, and follows nothing', async () => {
      const run = await sandbox().forRun(input({ packageInstall: true }));
      const victim = join(root, 'victim');
      mkdirSync(join(victim, 'sub'), { recursive: true });
      writeFileSync(join(victim, 'file'), 'keep');
      rmSync(pnpmLockDir, { recursive: true });
      symlinkSync(victim, pnpmLockDir);
      await run.dispose();
      expect(existsSync(pnpmLockDir)).toBe(false);
      expect(readdirSync(victim).sort()).toEqual(['file', 'sub']);
    });

    /** Writes `name` in `dir`, making `dir` first, and returns its path. */
    const writeIn = (dir: string, name: string, text = 'x'): string => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), text);
      return join(dir, name);
    };
    /** A file's user flags and ACL, as `stat` and `ls -le` show them. */
    const metadata = (path: string): { readonly flags: string; readonly acl: string } => ({
      flags: execFileSync('/usr/bin/stat', ['-f', '%Sf', path], { encoding: 'utf8' }).trim(),
      acl: execFileSync('/bin/ls', ['-led', path], { encoding: 'utf8' })
        .split('\n')
        .slice(1)
        .join('\n')
        .trim(),
    });
    /** Undoes what a test set on a file, so the test can remove it. */
    const unlock = (path: string): void => {
      execFileSync('/usr/bin/chflags', ['nouchg,nouappnd', path]);
      execFileSync('/bin/chmod', ['-N', path]);
    };

    // macOS's user flags and ACLs: they keep their owner from removing what a directory holds.
    it.skipIf(process.platform !== 'darwin')(
      'clears the user flags and ACLs a run set on directories in the lock directory, and removes what they held',
      async () => {
        const run = await sandbox().forRun(input({ packageInstall: true }));
        for (const name of ['appended', 'immutable', 'acl']) writeIn(join(pnpmLockDir, name), 'x');
        execFileSync('/usr/bin/chflags', ['uappnd', join(pnpmLockDir, 'appended')]);
        execFileSync('/usr/bin/chflags', ['uchg', join(pnpmLockDir, 'immutable')]);
        execFileSync('/bin/chmod', ['+a', 'everyone deny delete_child', join(pnpmLockDir, 'acl')]);
        await run.dispose();
        expect(existsSync(pnpmLockDir)).toBe(false);
        expect(readdirSync(root).filter((name) => name.includes('sweep'))).toEqual([]);
        expect(readdirSync(tmpRoot)).toEqual([]);
        expect(warnings).toEqual([]);
      },
    );

    it.skipIf(process.platform !== 'darwin')(
      "never changes a file's flags or ACL: one it can't remove is left, logged, with both as they were",
      async () => {
        const run = await sandbox().forRun(input({ packageInstall: true }));
        const stuck = join(pnpmLockDir, 'stuck.lock');
        writeFileSync(stuck, '');
        execFileSync('/bin/chmod', ['+a', 'everyone deny write', stuck]);
        execFileSync('/usr/bin/chflags', ['uchg', stuck]);
        const before = metadata(stuck);
        expect(before.flags).toContain('uchg');
        expect(before.acl).toContain('deny write');
        await run.dispose();
        const [moved, ...more] = readdirSync(tmpRoot);
        expect(more).toEqual([]);
        const left = join(tmpRoot, moved ?? '', 'stuck.lock');
        try {
          expect(metadata(left)).toEqual(before);
          expect(warnings.map((w) => w.fields['path'])).toEqual([join(tmpRoot, moved ?? '')]);
        } finally {
          if (existsSync(left)) unlock(left);
        }
      },
    );

    it.skipIf(process.platform !== 'darwin')(
      'leaves the flags and ACL of a file that a second link in the lock directory names',
      async () => {
        const run = await sandbox().forRun(input({ packageInstall: true }));
        const outside = join(root, 'outside');
        mkdirSync(outside);
        const withAcl = writeIn(outside, 'acl.txt', 'keep');
        const immutable = writeIn(outside, 'immutable.txt', 'keep');
        execFileSync('ln', [withAcl, join(pnpmLockDir, 'acl.lock')]);
        execFileSync('ln', [immutable, join(pnpmLockDir, 'immutable.lock')]);
        // Set after the links: macOS links no immutable file.
        execFileSync('/bin/chmod', ['+a', 'everyone deny write', withAcl]);
        execFileSync('/usr/bin/chflags', ['uchg', immutable]);
        const before = { withAcl: metadata(withAcl), immutable: metadata(immutable) };
        try {
          await run.dispose();
          expect({ withAcl: metadata(withAcl), immutable: metadata(immutable) }).toEqual(before);
          // The second name of an immutable file can't be unlinked: its tree is left and logged.
          expect(warnings).toHaveLength(1);
        } finally {
          unlock(withAcl);
          unlock(immutable);
          for (const name of readdirSync(tmpRoot)) {
            const lock = join(tmpRoot, name, 'immutable.lock');
            if (existsSync(lock)) unlock(lock);
          }
        }
      },
    );

    it("logs what it can't remove in the temp root, closed to every sandbox, and lets every later run go on", async () => {
      // A tree locked deeper than two runs' sweeps open, as a run could leave the lock directory:
      // each run sweeps twice, and each sweep opens `UNLOCK_PASSES` levels.
      const leftover = join(tmpRoot, `pnpm-sweep-${randomUUID()}`);
      const levels = Array.from({ length: 2 * 2 * UNLOCK_PASSES + 4 }, (_, n) =>
        join(leftover, ...Array.from({ length: n + 1 }, () => 'd')),
      );
      mkdirSync(levels.at(-1) ?? leftover, { recursive: true });
      writeFileSync(join(levels.at(-1) ?? leftover, 'f'), '');
      for (const level of [...levels].reverse()) chmodSync(level, 0o000);
      try {
        for (const attempt of [1, 2]) {
          const run = await sandbox().forRun(input({ packageInstall: true }));
          expect(run.commandEnv['TMPDIR'], `run ${String(attempt)}`).toBe(run.tmpDir);
          await run.dispose();
        }
        expect(existsSync(leftover)).toBe(true);
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings.every((w) => w.fields['path'] === leftover)).toBe(true);
        expect(warnings[0]?.message).toContain("pnpm's lock directory");
      } finally {
        if (existsSync(leftover)) execFileSync('/bin/chmod', ['-R', 'u+rwx', leftover]);
      }
    });

    it('walks a lock directory of many directories off the event loop', async () => {
      mkdirSync(pnpmLockDir, { mode: 0o700 });
      for (let n = 0; n < 200; n += 1) {
        mkdirSync(join(pnpmLockDir, `d${String(n)}`, 'locked'), { recursive: true });
        chmodSync(join(pnpmLockDir, `d${String(n)}`, 'locked'), 0o000);
      }
      // The root's Spotlight marker is no moved tree.
      keepSpotlightOut(tmpRoot);
      let ticked = false;
      const sweeping = sweepPnpmLockDir(pnpmLockDir, tmpRoot);
      setImmediate(() => {
        ticked = true;
      });
      await sweeping;
      expect(ticked).toBe(true);
      expect(existsSync(pnpmLockDir)).toBe(false);
      expect(readdirSync(tmpRoot)).toEqual(['.metadata_never_index']);
    });

    it("walks nothing when the lock directory can't be moved into the temp root", async () => {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'keep'), 'k');
      mkdirSync(pnpmLockDir, { mode: 0o700 });
      symlinkSync(outside, join(pnpmLockDir, 'abc.lock'));
      writeFileSync(join(pnpmLockDir, 'all-stores.lock'), '');
      const pending = createGateSandbox({
        home,
        dataDir,
        loginConfigDir: null,
        tmpRoot: join(root, 'no-temp-root'),
        filesRoot,
        pnpmLockDir,
        gitDirs: (path) => git.gitDirs(path),
        systemPrefixes: [],
        runtime: RUNTIME,
        log,
      }).forRun(input({ packageInstall: true }));
      await expect(pending).rejects.toThrow(SandboxProfileError);
      expect(readdirSync(pnpmLockDir).sort()).toEqual(['abc.lock', 'all-stores.lock']);
      expect(readdirSync(outside)).toEqual(['keep']);
      expect(readdirSync(filesRoot)).toEqual([]);
    });

    it.each([
      [
        'a file',
        () => {
          writeFileSync(pnpmLockDir, '');
        },
      ],
      [
        'open to other users',
        () => {
          mkdirSync(pnpmLockDir, { mode: 0o755 });
        },
      ],
    ])('replaces a lock directory path that is %s', async (_name, plant) => {
      plant();
      const run = await sandbox().forRun(input({ packageInstall: true }));
      expect(lstatSync(pnpmLockDir).mode & 0o777).toBe(0o700);
      await run.dispose();
    });
  });
});
