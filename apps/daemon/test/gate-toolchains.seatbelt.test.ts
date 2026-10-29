import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGit } from '../src/git';
import { silentLogger } from '../src/log';
import { resolveSandboxRuntime } from '../src/paths';
import { createGateSandbox } from '../src/sandbox';
import { createGateRunner, type GateResult, type GateRunner } from '../src/verify';
import { createTempRepo, type TempDir } from './fixtures';

/**
 * The toolchains a gate resolves under the real sandbox: mise's installs and Apple's xcrun shims
 * (`/usr/bin/git`, `make`), with the profile the daemon builds. Runs in `make gate` on macOS;
 * skipped on Linux, which has no Seatbelt, and inside a sandbox (`TENDB_SANDBOX=1`).
 */
const SEATBELT = process.platform === 'darwin' && process.env['TENDB_SANDBOX'] !== '1';

/** Where `name` lies on the PATH this test runs with, or null. */
function onPath(name: string): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (dir !== '' && existsSync(candidate)) return candidate;
  }
  return null;
}

/** True when the Xcode command line tools are installed, so `/usr/bin/git` is a working xcrun shim. */
function xcodeToolsInstalled(): boolean {
  try {
    execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A rust version mise holds as a link to rustup's proxies (`~/.cargo/bin`), the way mise adopts a
 * rustup-managed rust, or null when the builder has none.
 */
function rustupLinkedRust(): string | null {
  const installs = join(homedir(), '.local', 'share', 'mise', 'installs', 'rust');
  try {
    const proxies = realpathSync(join(homedir(), '.cargo', 'bin'));
    if (!existsSync(join(homedir(), '.rustup', 'settings.toml'))) return null;
    return (
      readdirSync(installs)
        .sort()
        .reverse()
        .find(
          (name) => /^\d+\.\d+\.\d+$/.test(name) && realpathSync(join(installs, name)) === proxies,
        ) ?? null
    );
  } catch {
    return null;
  }
}

const RUSTUP_RUST = rustupLinkedRust();

const FORBIDDEN = /Operation not permitted|couldn't create cache file|mise (WARN|ERROR)/;

describe.skipIf(!SEATBELT)('toolchains under the gate sandbox (Seatbelt)', () => {
  const token = randomBytes(8).toString('hex');
  let root: string;
  let repo: TempDir;
  let checkout: string;
  let fakeHome: string;
  const gates = new Map<string, GateRunner>();

  const gateFor = (home: string): GateRunner => {
    const existing = gates.get(home);
    if (existing !== undefined) return existing;
    const git = createGit();
    const gate = createGateRunner({
      sandbox: createGateSandbox({
        home,
        dataDir: join(home, 'Library', 'Application Support', '10db'),
        loginConfigDir: null,
        gitDirs: (path) => git.gitDirs(path),
        tmpRoot: join(root, 't'),
        runtime: resolveSandboxRuntime(),
      }),
      logger: silentLogger,
    });
    gates.set(home, gate);
    return gate;
  };

  const run = (command: string, home: string, env: Record<string, string>): Promise<GateResult> =>
    gateFor(home).run({
      project: { repoPath: checkout, sandboxLoopback: false },
      command,
      logPath: join(root, 'logs', `${randomBytes(4).toString('hex')}.log`),
      timeoutMs: 90_000,
      env,
      rules: [],
      checkouts: [checkout],
    });

  /** Runs each probe in the gate and reports which ones got through. */
  async function probe(
    probes: Record<string, string>,
    home: string,
    env: Record<string, string>,
    prelude = '',
  ): Promise<Record<string, 'ok' | 'denied'>> {
    const script = `${prelude}\n${Object.entries(probes)
      .map(
        ([name, command]) =>
          `if ( ${command} ) >/dev/null 2>&1; then echo "probe ${name} ok"; else echo "probe ${name} denied"; fi`,
      )
      .join('\n')}`;
    const result = await run(script, home, env);
    expect(result.exitCode, result.tail).toBe(0);
    return Object.fromEntries(
      [...result.tail.matchAll(/^probe (\S+) (ok|denied)$/gm)].map((m) => [m[1], m[2]]),
    ) as Record<string, 'ok' | 'denied'>;
  }

  beforeAll(() => {
    // A short root: the gate's temp dir must fit the socket path limit.
    root = realpathSync(mkdtempSync('/tmp/sbt-'));
    mkdirSync(join(root, 't'));
    repo = createTempRepo();
    checkout = realpathSync(repo.path);
    // A builder's home with mise installs, state, downloads, a plugin and an age key.
    fakeHome = join(root, 'home');
    const mise = join(fakeHome, '.local', 'share', 'mise');
    const version = join(mise, 'installs', 'node', '1.0.0');
    for (const [rel, text] of [
      [join(version, 'bin', 'node'), '#!/bin/sh\necho fake-node\n'],
      [join(version, 'lib', 'x.js'), 'x'],
      [join(version, 'etc', 'npmrc'), `//registry.example/:_authToken=${token}\n`],
      [join(version, 'etc', 'other'), `other-${token}\n`],
      [join(mise, 'downloads', 'node.tar.gz'), `download-${token}\n`],
      [join(mise, 'plugins', 'p', 'plugin'), `plugin-${token}\n`],
      [join(fakeHome, '.config', 'mise', 'age.txt'), `age-${token}\n`],
    ] as const) {
      mkdirSync(join(rel, '..'), { recursive: true });
      writeFileSync(rel, text);
    }
    mkdirSync(join(fakeHome, '.local', 'state', 'mise'), { recursive: true });
  });

  afterAll(() => {
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it("lists mise's installs and reads their files, but nothing else of mise's tree and no secret", async () => {
    const mise = join(fakeHome, '.local', 'share', 'mise');
    const version = join(mise, 'installs', 'node', '1.0.0');
    const seen = await probe(
      {
        'list-installs': `ls ${join(mise, 'installs')}`,
        'list-tool': `ls ${join(mise, 'installs', 'node')}`,
        'list-version': `ls ${version}`,
        'read-bin': `cat ${join(version, 'bin', 'node')}`,
        'read-lib': `cat ${join(version, 'lib', 'x.js')}`,
        'read-npmrc': `cat ${join(version, 'etc', 'npmrc')}`,
        'list-etc': `ls ${join(version, 'etc')}`,
        'read-etc-other': `cat ${join(version, 'etc', 'other')}`,
        'list-data-dir': `ls ${mise}`,
        'read-downloads': `cat ${join(mise, 'downloads', 'node.tar.gz')}`,
        'read-plugin': `cat ${join(mise, 'plugins', 'p', 'plugin')}`,
        'read-age-key': `cat ${join(fakeHome, '.config', 'mise', 'age.txt')}`,
        'list-home': `ls ${fakeHome}`,
        'write-installs': `touch ${join(mise, 'installs', 'probe')}`,
        'write-version': `touch ${join(version, 'bin', 'probe')}`,
        'write-state': `touch ${join(fakeHome, '.local', 'state', 'mise', 'probe')}`,
      },
      fakeHome,
      { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: fakeHome },
    );
    expect(seen).toEqual({
      'list-installs': 'ok',
      'list-tool': 'ok',
      'list-version': 'denied',
      'read-bin': 'ok',
      'read-lib': 'ok',
      'read-npmrc': 'denied',
      'list-etc': 'denied',
      'read-etc-other': 'denied',
      'list-data-dir': 'denied',
      'read-downloads': 'denied',
      'read-plugin': 'denied',
      'read-age-key': 'denied',
      'list-home': 'denied',
      'write-installs': 'denied',
      'write-version': 'denied',
      'write-state': 'denied',
    });
  }, 120_000);

  it("keeps a version installed after the profile is built closed, its etc and npmrc included, though mise's installs list", async () => {
    const mise = join(fakeHome, '.local', 'share', 'mise');
    const late = join(mise, 'installs', 'node', '2.0.0');
    const started = join(checkout, 'started');
    const go = join(checkout, 'go');
    // The command starts under the profile built before the version exists, says so, and waits for
    // the host to install the version before it probes.
    const prelude = `: > ${started}; n=0; while [ ! -e ${go} ] && [ $n -lt 600 ]; do sleep 0.1; n=$((n+1)); done`;
    const running = probe(
      {
        'list-tool': `ls ${join(mise, 'installs', 'node')}`,
        'read-late-npmrc': `cat ${join(late, 'etc', 'npmrc')}`,
        'read-late-etc-other': `cat ${join(late, 'etc', 'other')}`,
        'read-late-bin': `cat ${join(late, 'bin', 'node')}`,
        'list-late': `ls ${late}`,
        'read-early-bin': `cat ${join(mise, 'installs', 'node', '1.0.0', 'bin', 'node')}`,
      },
      fakeHome,
      { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: fakeHome },
      prelude,
    );
    const deadline = Date.now() + 60_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(started)).toBe(true);
    for (const [rel, text] of [
      [join(late, 'bin', 'node'), '#!/bin/sh\n'],
      [join(late, 'etc', 'npmrc'), `//registry.example/:_authToken=${token}\n`],
      [join(late, 'etc', 'other'), `other-${token}\n`],
    ] as const) {
      mkdirSync(join(rel, '..'), { recursive: true });
      writeFileSync(rel, text);
    }
    writeFileSync(go, '');
    expect(await running).toEqual({
      'list-tool': 'ok',
      'read-late-npmrc': 'denied',
      'read-late-etc-other': 'denied',
      'read-late-bin': 'denied',
      'list-late': 'denied',
      'read-early-bin': 'ok',
    });
  }, 150_000);

  it.skipIf(onPath('mise') === null)(
    "resolves the builder's mise installs with no error or warning",
    async () => {
      const result = await run('mise ls', homedir(), {
        ...(process.env as Record<string, string>),
      });
      expect(result.exitCode, result.tail).toBe(0);
      expect(result.tail).not.toMatch(FORBIDDEN);
    },
    120_000,
  );

  it.skipIf(onPath('mise') === null || RUSTUP_RUST === null)(
    "resolves a rust that mise links to the builder's rustup, with cargo's caches in the temp dir",
    async () => {
      const version = RUSTUP_RUST ?? '';
      const result = await run(
        `mise x 'rust[profile=minimal]@${version}' -- cargo --version && test -L "$CARGO_HOME/bin" && mise x 'rust[profile=minimal]@${version}' -- sh -c 'test "$CARGO_HOME" != "$HOME/.cargo"'`,
        homedir(),
        { ...(process.env as Record<string, string>) },
      );
      expect(result.exitCode, result.tail).toBe(0);
      expect(result.tail).toMatch(/^cargo \d+\.\d+\.\d+/m);
      expect(result.tail).not.toMatch(FORBIDDEN);
      expect(
        lstatSync(
          join(homedir(), '.local', 'share', 'mise', 'installs', 'rust', version),
        ).isSymbolicLink(),
      ).toBe(true);
    },
    120_000,
  );

  it.skipIf(!xcodeToolsInstalled())(
    "runs Apple's xcrun shims (git and make) with no error",
    async () => {
      const result = await run(
        '/usr/bin/git --version && /usr/bin/make --version && git -C . status --short',
        homedir(),
        { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir() },
      );
      expect(result.exitCode, result.tail).toBe(0);
      expect(result.tail).toContain('git version');
      expect(result.tail).not.toMatch(FORBIDDEN);
    },
    120_000,
  );
});
