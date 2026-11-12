import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGit } from '../src/git';
import { silentLogger } from '../src/log';
import { resolveSandboxRuntime } from '../src/paths';
import {
  claimSandboxTempRoot,
  createGateSandbox,
  createLaneTempDir,
  DOCKER_REFUSAL,
  ensurePrivateRoot,
  laneTempRoot,
  removeLaneTempDir,
} from '../src/sandbox';
import {
  createGateRunner,
  type GateRequest,
  type GateResult,
  type GateRunner,
} from '../src/verify';
import { createTempRepo, isolatedGitEnv, tempDir, waitForAsync, type TempDir } from './fixtures';

/**
 * The gate under the real sandbox: srt and Seatbelt, with the profile the daemon builds. Runs in
 * `make gate` on macOS; skipped on Linux, which has no Seatbelt, and inside a sandbox, where
 * Seatbelt can't nest (`TENDB_SANDBOX=1`, which every sandboxed command gets).
 */
const SEATBELT = process.platform === 'darwin' && process.env['TENDB_SANDBOX'] !== '1';

const listen = (server: Server, at: string | number): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    if (typeof at === 'number') server.listen(at, '127.0.0.1', resolve);
    else server.listen(at, resolve);
  });

describe.skipIf(!SEATBELT)('the gate under the sandbox (Seatbelt)', () => {
  const token = randomBytes(8).toString('hex');
  // Where the builder's secrets live: home itself, outside every path the profile opens.
  const canary = join(homedir(), `.10db-gate-canary-${token}`);
  const homeProbe = join(homedir(), `.10db-gate-write-${token}`);
  let root: string;
  /** The daemon's own temp root, where the gate's temp dir is made beside another sandbox's. */
  let tmpRoot: string;
  let otherTemp: string;
  let claim: ReturnType<typeof claimSandboxTempRoot>;
  let filesCanary: string;
  let repo: TempDir;
  let checkout: string;
  let agent: Server;
  let web: Server;
  let webPort: number;
  let gate: GateRunner;

  beforeAll(async () => {
    writeFileSync(canary, `canary-${token}\n`);
    root = realpathSync(mkdtempSync('/tmp/sbs-'));
    // The daemon's root, as its start makes it: srt runs the gate at `/Users/Shared/10db-<uid>`.
    tmpRoot = ensurePrivateRoot(laneTempRoot());
    // Marked as a running daemon's while the tests run, so a test daemon that starts meanwhile, the
    // bundle test's, leaves the temp dirs here alone.
    claim = claimSandboxTempRoot(tmpRoot);
    otherTemp = createLaneTempDir(tmpRoot);
    writeFileSync(join(otherTemp, 'canary'), `canary-${token}\n`);
    mkdirSync(join(root, 'r'));
    filesCanary = join(root, 'r', '10db-mcp-0123456789ab.sh');
    writeFileSync(filesCanary, `export TOKEN='canary-${token}'\n`);
    const git = createGit();
    gate = createGateRunner({
      sandbox: createGateSandbox({
        home: homedir(),
        dataDir: join(homedir(), 'Library', 'Application Support', '10db'),
        loginConfigDir: null,
        gitDirs: (path) => git.gitDirs(path),
        tmpRoot,
        filesRoot: join(root, 'r'),
        codexLaneTempRoot: join(root, 'l'),
        log: silentLogger,
        pnpmLockDir: join(root, 'pnpm-locks'),
        runtime: resolveSandboxRuntime(),
      }),
      logger: silentLogger,
    });
    repo = createTempRepo();
    checkout = realpathSync(repo.path);
    writeFileSync(
      join(checkout, 'check.test.mjs'),
      [
        "import { test } from 'node:test';",
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "test('reads the checkout and writes its temp dir and output', () => {",
        "  readFileSync('check.test.mjs');",
        "  writeFileSync(join(process.env.TMPDIR, 'scratch'), 'x');",
        "  writeFileSync('out.txt', 'built');",
        '});',
        '',
      ].join('\n'),
    );
    // Stands in for the SSH agent: a socket outside the gate's temp dir.
    // A probe connects and leaves; its reset is no failure.
    agent = createServer((socket) => {
      socket.on('error', () => undefined);
      socket.end();
    });
    await listen(agent, join(root, 'agent.sock'));
    web = createServer((socket) => {
      socket.on('error', () => undefined);
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
    await listen(web, 0);
    const address = web.address();
    webPort = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(() => {
    removeLaneTempDir(otherTemp, tmpRoot);
    claim.release();
    agent.close();
    web.close();
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(canary, { force: true });
    rmSync(homeProbe, { force: true });
  });

  const env = (): Record<string, string> => ({
    ...Object.fromEntries(
      Object.entries(process.env).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, value]],
      ),
    ),
    GH_TOKEN: `ghp_${token}`,
    AWS_SECRET_ACCESS_KEY: `aws-${token}`,
    SSH_AUTH_SOCK: join(root, 'agent.sock'),
  });
  const run = (command: string, overrides: Partial<GateRequest> = {}): Promise<GateResult> =>
    gate.run({
      project: { repoPath: checkout, sandboxLoopback: false },
      command,
      logPath: join(root, 'logs', `${randomBytes(4).toString('hex')}.log`),
      timeoutMs: 60_000,
      env: env(),
      rules: [],
      checkouts: [checkout],
      ...overrides,
    });

  /** Runs each probe in the gate and reports which ones got through. */
  async function probe(
    probes: Record<string, string>,
    overrides: Partial<GateRequest> = {},
  ): Promise<Record<string, 'ok' | 'denied'>> {
    const script = Object.entries(probes)
      .map(
        ([name, command]) =>
          `if ( ${command} ) >/dev/null 2>&1; then echo "probe ${name} ok"; else echo "probe ${name} denied"; fi`,
      )
      .join('\n');
    const result = await run(script, overrides);
    expect(result.exitCode, result.tail).toBe(0);
    return Object.fromEntries(
      [...result.tail.matchAll(/^probe (\S+) (ok|denied)$/gm)].map((m) => [m[1], m[2]]),
    ) as Record<string, 'ok' | 'denied'>;
  }

  const connect = (target: string): string =>
    `node -e "require('net').connect(${target}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`;

  it('passes a normal test command that reads the checkout and writes its own output', async () => {
    const result = await run('node --test check.test.mjs && test -f out.txt && git status --short');
    expect(result.exitCode, result.tail).toBe(0);
    expect(result.tail).toContain('out.txt');
  }, 60_000);

  it("keeps the builder's secrets, other files and credentials away from the gate", async () => {
    const seen = await probe({
      'home-canary': `cat ${canary}`,
      'home-listing': 'ls ~',
      'ssh-dir': 'ls ~/.ssh',
      'config-dir': 'ls ~/.config',
      'write-home': `touch ${homeProbe}`,
      'write-outside': `touch ${join(root, 'outside')}`,
      'write-git-state': 'touch .git/probe',
      'gh-token': 'test -n "$GH_TOKEN"',
      'aws-key': 'test -n "$AWS_SECRET_ACCESS_KEY"',
      'ssh-agent-var': 'test -n "$SSH_AUTH_SOCK"',
      'ssh-agent-socket': connect(`'${join(root, 'agent.sock')}'`),
      'docker-socket': connect("'/var/run/docker.sock'"),
      'other-host': 'curl -fsS -m 10 https://example.com',
      'direct-address': "curl -fsS -m 10 --noproxy '*' https://1.1.1.1",
      'loopback-off': connect(String(webPort)),
      // Another sandbox's temp dir beside the gate's, and a sealed file in the files root.
      'other-temp-read': `cat '${join(otherTemp, 'canary')}'`,
      'other-temp-write': `touch '${join(otherTemp, 'planted')}'`,
      'temp-root-listing': `ls '${tmpRoot}'`,
      'files-root-read': `cat '${filesCanary}'`,
      // Controls: the probes can succeed, and the sandbox's own variables arrive as set.
      'write-checkout': 'touch inside && rm inside',
      'write-temp': 'touch "$TMPDIR/inside" && cat "$TMPDIR/inside" && ls "$TMPDIR"',
      // Its own temp dir, named by six characters alone, in the root.
      'temp-under-root': `case "$TMPDIR" in '${tmpRoot}'/${'[A-Za-z0-9]'.repeat(6)}) true ;; *) false ;; esac`,
      'own-env':
        'test "$GIT_CONFIG_GLOBAL" = /dev/null && test "$GIT_OPTIONAL_LOCKS" = 0 && ' +
        'test "$TENDB_SANDBOX" = 1 && test "$CARGO_HOME" = "$TMPDIR/cache/cargo" && ' +
        'test "$XDG_CONFIG_HOME" = "$TMPDIR/config" && test "$MISE_CONFIG_DIR" = "$TMPDIR/mise"',
    });
    expect(seen).toEqual({
      'home-canary': 'denied',
      'home-listing': 'denied',
      'ssh-dir': 'denied',
      'config-dir': 'denied',
      'write-home': 'denied',
      'write-outside': 'denied',
      'write-git-state': 'denied',
      'gh-token': 'denied',
      'aws-key': 'denied',
      'ssh-agent-var': 'denied',
      'ssh-agent-socket': 'denied',
      'docker-socket': 'denied',
      'other-host': 'denied',
      'direct-address': 'denied',
      'loopback-off': 'denied',
      'other-temp-read': 'denied',
      'other-temp-write': 'denied',
      'temp-root-listing': 'denied',
      'files-root-read': 'denied',
      'write-checkout': 'ok',
      'write-temp': 'ok',
      'temp-under-root': 'ok',
      'own-env': 'ok',
    });
  }, 120_000);

  it("keeps a project's browser sign-in and its dev login's log away from the gate", async () => {
    // The data dir inside the checkout, which a gate reads: only the protected reads keep it out.
    const dataDir = join(checkout, '.10db-data');
    const browser = join(dataDir, 'browser', 'prj_x');
    mkdirSync(browser, { recursive: true });
    writeFileSync(join(browser, 'state.json'), `{"cookies":[{"value":"canary-${token}"}]}`);
    writeFileSync(join(browser, 'login-1.log'), `http://localhost:8800/login/canary-${token}/`);
    writeFileSync(join(checkout, 'readable'), 'ok');
    const git = createGit();
    const withData = createGateRunner({
      sandbox: createGateSandbox({
        home: homedir(),
        dataDir,
        loginConfigDir: null,
        gitDirs: (path) => git.gitDirs(path),
        tmpRoot,
        filesRoot: join(root, 'r'),
        codexLaneTempRoot: join(root, 'l'),
        log: silentLogger,
        pnpmLockDir: join(root, 'pnpm-locks'),
        runtime: resolveSandboxRuntime(),
      }),
      logger: silentLogger,
    });
    const script = [
      ['state', `cat '${join(browser, 'state.json')}'`],
      ['login-log', `cat '${join(browser, 'login-1.log')}'`],
      ['browser-listing', `ls '${browser}'`],
      ['control', `cat '${join(checkout, 'readable')}'`],
    ]
      .map(
        ([name, command]) =>
          `if ( ${command ?? 'false'} ) >/dev/null 2>&1; then echo "probe ${name ?? ''} ok"; else echo "probe ${name ?? ''} denied"; fi`,
      )
      .join('\n');
    const result = await withData.run({
      project: { repoPath: checkout, sandboxLoopback: false },
      command: script,
      logPath: join(root, 'logs', `${randomBytes(4).toString('hex')}.log`),
      timeoutMs: 60_000,
      env: env(),
      rules: [],
      checkouts: [checkout],
    });
    expect(result.exitCode, result.tail).toBe(0);
    expect(
      Object.fromEntries(
        [...result.tail.matchAll(/^probe (\S+) (ok|denied)$/gm)].map((m) => [m[1], m[2]]),
      ),
    ).toEqual({
      state: 'denied',
      'login-log': 'denied',
      'browser-listing': 'denied',
      control: 'ok',
    });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(join(checkout, 'readable'), { force: true });
  }, 60_000);

  it("can't write the main checkout or a sibling worktree from a gate in a worktree", async () => {
    const worktrees = tempDir('gate-worktrees');
    try {
      const env = isolatedGitEnv();
      const add = (name: string) => {
        const path = join(worktrees.path, name);
        execFileSync('git', ['-C', checkout, 'worktree', 'add', '-q', '-b', name, path], {
          env,
          stdio: 'pipe',
        });
        return realpathSync(path);
      };
      const mine = add('mine');
      const sibling = add('sibling');
      // The git probes would succeed with no sandbox, so a denial below is the sandbox's.
      const control = add('control');
      execFileSync(
        '/bin/sh',
        ['-c', `printf x >> .git && touch "$(sed -n 's/^gitdir: //p' .git)/probe"`],
        { cwd: control, env, stdio: 'pipe' },
      );
      const seen = await probe(
        {
          'write-main': `touch ${join(checkout, 'probe')}`,
          'write-sibling': `touch ${join(sibling, 'probe')}`,
          'write-gitfile': 'printf x >> .git',
          'write-own-git-dir': `touch "$(sed 's/^gitdir: //' .git)/probe"`,
          'write-common-dir': `touch ${join(checkout, '.git', 'probe')}`,
          'write-worktree': 'touch inside && rm inside',
        },
        {
          project: { repoPath: mine, sandboxLoopback: false },
          checkouts: [checkout, mine, sibling],
        },
      );
      expect(seen).toEqual({
        'write-main': 'denied',
        'write-sibling': 'denied',
        'write-gitfile': 'denied',
        'write-own-git-dir': 'denied',
        'write-common-dir': 'denied',
        'write-worktree': 'ok',
      });
    } finally {
      worktrees.cleanup();
    }
  }, 120_000);

  it("reaches the project's allowed hosts through the proxy, and localhost only when it is on", async () => {
    const viaProxy = `curl -fsS -m 10 --noproxy '' -x "$HTTP_PROXY" http://127.0.0.1:${String(webPort)}/`;
    expect(
      await probe(
        { allowed: viaProxy, loopback: connect(String(webPort)) },
        { rules: [{ toolName: 'SandboxNetworkAccess', pattern: '127.0.0.1' }] },
      ),
    ).toEqual({ allowed: 'ok', loopback: 'denied' });
    expect(
      await probe(
        { loopback: connect(String(webPort)) },
        { project: { repoPath: checkout, sandboxLoopback: true } },
      ),
    ).toEqual({ loopback: 'ok' });
  }, 120_000);

  // Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: a project's preview command runs
  // through this runner with no timeout of its own, and the builder's browser must reach what it serves.
  it("serves a loopback port the builder's browser reaches while it runs, as a preview does, and stops on abort", async () => {
    const free = createServer();
    await listen(free, 0);
    const address = free.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((resolve) =>
      free.close(() => {
        resolve();
      }),
    );
    const page = `http://127.0.0.1:${String(port)}/`;
    const answers = () =>
      fetch(page).then(
        () => true,
        () => false,
      );
    const serve = `exec node -e "require('http').createServer((q, s) => s.end('ok')).listen(${String(port)}, '127.0.0.1')"`;
    const abort = new AbortController();
    const serving = run(serve, {
      project: { repoPath: checkout, sandboxLoopback: true },
      timeoutMs: 120_000,
      signal: abort.signal,
    });
    await waitForAsync(answers, 30_000);
    abort.abort();
    expect((await serving).aborted).toBe(true);
    expect(await answers()).toBe(false);
    // Without Allow loopback nothing may listen, so the preview can't serve at all.
    const refused = await run(serve, { project: { repoPath: checkout, sandboxLoopback: false } });
    expect(refused.exitCode).not.toBe(0);
    expect(await answers()).toBe(false);
  }, 120_000);

  // srt exits 0 when its own child dies by TERM or INT: none of these may pass.
  it.each([
    ['the gate kills its own group with TERM', 'echo partial; kill -TERM 0; sleep 5'],
    ['the gate kills itself with INT', 'echo partial; kill -INT $$'],
    ['the gate kills itself with TERM', 'echo partial; kill -TERM $$'],
  ])(
    'fails when %s',
    async (_name, command) => {
      const result = await run(command);
      expect(result.exitCode, result.tail).not.toBe(0);
      expect(result.tail).toContain('partial');
    },
    60_000,
  );

  it('fails a gate whose srt is sent SIGTERM from outside', async () => {
    const started = join(checkout, `started-${randomBytes(4).toString('hex')}`);
    let srt = 0;
    const pending = run(`touch ${started}; sleep 3; echo finished`, {
      onSpawn: (pid) => {
        srt = pid;
      },
    });
    const deadline = Date.now() + 30_000;
    while (!existsSync(started)) {
      if (Date.now() > deadline) throw new Error('the gate never started');
      await new Promise((resolve) => setImmediate(resolve));
    }
    process.kill(srt, 'SIGTERM');
    const result = await pending;
    rmSync(started, { force: true });
    expect(result.exitCode, result.tail).not.toBe(0);
  }, 60_000);

  it('fails a gate that needs Docker, and its evidence says why', async () => {
    const result = await run('docker ps');
    expect(result.exitCode).not.toBe(0);
    expect(result.tail.trimEnd().endsWith(DOCKER_REFUSAL)).toBe(true);
  }, 60_000);

  // Value: protects criterion 2 under the real srt; fails_when srt ignores the gate's
  // allowUnixSockets, needs the socket's real path or its parent dir readable, or the shim is still
  // written with the switch on; why_new: the unit rung read only the settings JSON; no_claim: a real
  // Docker engine (a Unix socket server stands in for it, named by DOCKER_HOST as a builder's is).
  it("reaches the engine socket and gets no refusing docker only when the project's Docker switch is on", async () => {
    const engine = join(root, 'agent.sock');
    const dockerEnv = { ...env(), DOCKER_HOST: `unix://${engine}` };
    const probes = {
      'engine-socket': connect(`'${engine}'`),
      'no-shim': 'test ! -e "$TMPDIR/bin/docker"',
      'docker-host': `test "$DOCKER_HOST" = 'unix://${engine}'`,
    };
    expect(
      await probe(probes, {
        project: { repoPath: checkout, sandboxLoopback: false, sandboxDocker: true },
        env: dockerEnv,
      }),
    ).toEqual({ 'engine-socket': 'ok', 'no-shim': 'ok', 'docker-host': 'ok' });
    expect(
      await probe(probes, {
        project: { repoPath: checkout, sandboxLoopback: false, sandboxDocker: false },
        env: dockerEnv,
      }),
    ).toEqual({ 'engine-socket': 'denied', 'no-shim': 'denied', 'docker-host': 'denied' });
  }, 120_000);

  it("opens pnpm's lock files to a package install only", async () => {
    // pnpm opens its lock files read-write; the probe does the same and takes the lock.
    const lock = join(root, 'pnpm-locks', 'all-stores.lock');
    const take = `perl -MFcntl=:flock,:DEFAULT -e 'sysopen(my $f, $ARGV[0], O_RDWR|O_CREAT, 0600) or exit 1; flock($f, LOCK_EX|LOCK_NB) or exit 1' '${lock}'`;
    const install = await run(take, { packageInstall: true });
    expect(install.exitCode, install.tail).toBe(0);
    // The directory is removed with whatever the run left in it.
    expect(existsSync(dirname(lock))).toBe(false);
    const ordinary = await run(take);
    expect(ordinary.exitCode, ordinary.tail).not.toBe(0);
  }, 60_000);
});
