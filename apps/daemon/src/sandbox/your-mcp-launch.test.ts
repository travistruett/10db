import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { laneWritableRoots, type LaneWritableRoot } from './lane-writable';
import {
  launchYourMcpServers,
  prepareYourMcpRun,
  type UnsandboxedStdioServer,
} from './your-mcp-launch';

let root: TempDir;
let home: string;
let checkout: string;
let worktrees: string;
let lanes: string;
let laneWritable: LaneWritableRoot[];

function executable(path: string): void {
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = tempDir('your-mcp-launch');
  const base = realpathSync(root.path);
  home = join(base, 'home');
  checkout = join(base, 'checkout');
  worktrees = join(base, 'worktrees');
  lanes = join(base, 'lanes');
  for (const dir of [join(home, 'bin'), join(checkout, 'node_modules', '.bin'), worktrees, lanes])
    mkdirSync(dir, { recursive: true });
  executable(join(home, 'bin', 'npx'));
  executable(join(home, 'bin', 'node'));
  executable(join(checkout, 'node_modules', '.bin', 'only-here'));
  executable(join(checkout, 'tool'));
  laneWritable = laneWritableRoots({
    checkouts: [checkout],
    worktreeBase: worktrees,
    sandboxTempRoots: [lanes],
    systemTempRoots: ['/private/tmp', '/private/var/tmp'],
  });
});

afterEach(() => {
  root.cleanup();
});

const loginPath = (): string => `${home}/bin:/usr/bin:/bin`;

function server(over: Partial<UnsandboxedStdioServer> = {}): UnsandboxedStdioServer {
  return {
    command: 'npx',
    args: ['-y', 'pkg'],
    cwd: null,
    env: { PATH: loginPath(), HOME: '/elsewhere', LANG: 'en_US.UTF-8' },
    declaredEnv: [],
    ...over,
  };
}

const prepare = (s: UnsandboxedStdioServer) => prepareYourMcpRun(s, { home, laneWritable });
const refusal = (s: UnsandboxedStdioServer): string | null => prepare(s).refusal;
const SUFFIX =
  ", which an agent can write. Run it from a project's .mcp.json instead, where 10db sandboxes it.";

describe('prepareYourMcpRun', () => {
  it('npx -y pkg from the home is allowed', () => {
    const run = prepare(server());
    expect(run.refusal).toBeNull();
    expect(run.env['HOME']).toBe(home);
    expect(run.dropped).toEqual([]);
  });

  it.each<[string, () => Partial<UnsandboxedStdioServer>, string]>([
    [
      'a command in a checkout is refused',
      () => ({ command: join(checkout, 'tool') }),
      `Its command points at a project's folder${SUFFIX}`,
    ],
    [
      'a command linked from the home into a checkout is refused',
      () => {
        symlinkSync(join(checkout, 'tool'), join(home, 'bin', 'linked'));
        return { command: 'linked' };
      },
      `Its command points at a project's folder${SUFFIX}`,
    ],
    [
      'node with a script in a checkout is refused',
      () => ({ command: 'node', args: [join(checkout, 'server.js')] }),
      `Its argument 1 points at a project's folder${SUFFIX}`,
    ],
    [
      'node with a script not yet built in a checkout is refused',
      () => ({ command: 'node', args: [join(checkout, 'dist', 'server.js')] }),
      `Its argument 1 points at a project's folder${SUFFIX}`,
    ],
    [
      '--config=<checkout>/x.json is refused',
      () => ({ args: ['-y', 'pkg', `--config=${join(checkout, 'x.json')}`] }),
      `Its argument 3 points at a project's folder${SUFFIX}`,
    ],
    [
      'uv --directory <checkout> run x is refused',
      () => ({ command: 'uv', args: ['--directory', checkout, 'run', 'x'] }),
      `Its argument 2 points at a project's folder${SUFFIX}`,
    ],
    [
      'an argument holding a checkout path inside other text is refused',
      () => ({ args: [`--opt=a,${checkout}/b`] }),
      `Its argument 1 points at a project's folder${SUFFIX}`,
    ],
    [
      'a cwd in a worktree made after the session started is refused',
      () => {
        mkdirSync(join(worktrees, 'later'));
        return { cwd: join(worktrees, 'later') };
      },
      `Its working folder points at the worktree folder${SUFFIX}`,
    ],
    [
      'a declared NODE_OPTIONS=--require <checkout>/x.js is refused',
      () => ({
        env: { ...server().env, NODE_OPTIONS: `--require ${checkout}/x.js` },
        declaredEnv: ['NODE_OPTIONS'],
      }),
      `Its NODE_OPTIONS points at a project's folder${SUFFIX}`,
    ],
    [
      'a declared PYTHONPATH with a checkout entry is refused',
      () => ({
        env: { ...server().env, PYTHONPATH: `/usr/lib/python:${checkout}/src` },
        declaredEnv: ['PYTHONPATH'],
      }),
      `Its PYTHONPATH points at a project's folder${SUFFIX}`,
    ],
    [
      'a declared DYLD_INSERT_LIBRARIES into a temp root is refused',
      () => ({
        env: { ...server().env, DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' },
        declaredEnv: ['DYLD_INSERT_LIBRARIES'],
      }),
      `Its DYLD_INSERT_LIBRARIES points at a temp folder${SUFFIX}`,
    ],
    [
      'a bare relative argument that climbs into a checkout is refused',
      () => ({ args: ['sub/../../checkout/server.js'] }),
      `Its argument 1 points at a project's folder${SUFFIX}`,
    ],
    [
      'a bare relative argument through a link in the home into a checkout is refused',
      () => {
        symlinkSync(checkout, join(home, 'linked-dir'));
        return { args: ['linked-dir/server.js'] };
      },
      `Its argument 1 points at a project's folder${SUFFIX}`,
    ],
    [
      'a path after a semicolon inside an option is refused',
      () => ({ args: [`--opt=a;${checkout}/b`] }),
      `Its argument 1 points at a project's folder${SUFFIX}`,
    ],
    [
      'a quoted path inside an option is refused',
      () => ({ args: [`--opt="${checkout}/b"`] }),
      `Its argument 1 points at a project's folder${SUFFIX}`,
    ],
    [
      'a path glued to a flag letter is refused',
      () => ({ args: [`-I${checkout}/include`] }),
      `Its argument 1 points at a project's folder${SUFFIX}`,
    ],
    [
      'a path glued to a long flag name is refused',
      () => ({ args: [`--x${checkout}`] }),
      `Its argument 1 points at a project's folder${SUFFIX}`,
    ],
    [
      'a path in a list after a comma and a colon is refused',
      () => ({ args: [`--paths=/usr/lib,/opt:${checkout}/b`] }),
      `Its argument 1 points at a project's folder${SUFFIX}`,
    ],
    [
      'a declared NODE_OPTIONS with a quoted checkout path is refused',
      () => ({
        env: { ...server().env, NODE_OPTIONS: `--require "${checkout}/x.js"` },
        declaredEnv: ['NODE_OPTIONS'],
      }),
      `Its NODE_OPTIONS points at a project's folder${SUFFIX}`,
    ],
    [
      'a declared NODE_OPTIONS with a path after a comma is refused',
      () => ({
        env: { ...server().env, NODE_OPTIONS: `--x=a,${checkout}/x.js` },
        declaredEnv: ['NODE_OPTIONS'],
      }),
      `Its NODE_OPTIONS points at a project's folder${SUFFIX}`,
    ],
    [
      'a declared NODE_OPTIONS with a path after a semicolon is refused',
      () => ({
        env: { ...server().env, NODE_OPTIONS: `--x=a;${checkout}/x.js` },
        declaredEnv: ['NODE_OPTIONS'],
      }),
      `Its NODE_OPTIONS points at a project's folder${SUFFIX}`,
    ],
    [
      'a declared NODE_OPTIONS with a path glued to a flag is refused',
      () => ({
        env: { ...server().env, NODE_OPTIONS: `-r${checkout}/x.js` },
        declaredEnv: ['NODE_OPTIONS'],
      }),
      `Its NODE_OPTIONS points at a project's folder${SUFFIX}`,
    ],
    [
      'a declared variable with a newline refuses the server',
      () => ({ env: { ...server().env, CERT: 'a\nb' }, declaredEnv: ['CERT'] }),
      "Its env variable CERT can't be passed to it.",
    ],
  ])('%s', (_name, over, reason) => {
    expect(refusal(server(over()))).toBe(reason);
  });

  it('a login NODE_OPTIONS with a quoted checkout path is dropped and named', () => {
    const run = prepare(
      server({ env: { ...server().env, NODE_OPTIONS: `--require "${checkout}/x.js"` } }),
    );
    expect(run.refusal).toBeNull();
    expect(run.dropped).toEqual(['NODE_OPTIONS']);
  });

  it.skipIf(process.platform !== 'darwin')(
    'a checkout path spelled in another case is refused where the file system folds case',
    () => {
      const shouted = join(checkout.toUpperCase(), 'server.js');
      expect(refusal(server({ args: [shouted] }))).toBe(
        `Its argument 1 points at a project's folder${SUFFIX}`,
      );
      expect(refusal(server({ args: [`--opt=a,${shouted}`] }))).toBe(
        `Its argument 1 points at a project's folder${SUFFIX}`,
      );
    },
  );

  it('a login PYTHONPATH into a checkout is dropped and named', () => {
    const run = prepare(server({ env: { ...server().env, PYTHONPATH: `${checkout}/src` } }));
    expect(run.refusal).toBeNull();
    expect(run.env).not.toHaveProperty('PYTHONPATH');
    expect(run.dropped).toEqual(['PYTHONPATH']);
  });

  it('a login variable with a newline is dropped and named; the server runs', () => {
    const run = prepare(server({ env: { ...server().env, PEM: 'line1\nline2' } }));
    expect(run.refusal).toBeNull();
    expect(run.env).not.toHaveProperty('PEM');
    expect(run.dropped).toEqual(['PEM']);
  });

  it('a PATH entry in a checkout is dropped, existing or not', () => {
    const path = `${checkout}/node_modules/.bin:${checkout}/not-yet:${loginPath()}`;
    expect(prepare(server({ env: { PATH: path } })).env['PATH']).toBe(loginPath());
  });

  it('a relative PATH entry is dropped', () => {
    const path = `node_modules/.bin:./bin:${loginPath()}`;
    expect(prepare(server({ env: { PATH: path } })).env['PATH']).toBe(loginPath());
  });

  it('no PATH is the host PATH', () => {
    expect(prepare(server({ env: {} })).env['PATH']).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('a bare name whose only PATH match is in a checkout is not found, not run', () => {
    const run = prepare(
      server({
        command: 'only-here',
        env: { PATH: `${checkout}/node_modules/.bin:${loginPath()}` },
      }),
    );
    expect(run.refusal).toBeNull();
    expect(run.env['PATH']).toBe(loginPath());
  });

  it('a missing command is not refused', () => {
    expect(refusal(server({ command: join(home, 'bin', 'missing') }))).toBeNull();
    expect(refusal(server({ command: 'missing' }))).toBeNull();
  });

  it('an argument that only looks like a word is not a path', () => {
    expect(refusal(server({ args: ['run', 'tmp', 'lanes', '--port=3000'] }))).toBeNull();
  });

  it('no refusal holds an argument’s or a value’s text', () => {
    const reasons = [
      refusal(server({ args: [`--key=sk-canary,${checkout}/b`] })),
      refusal(
        server({
          env: { NODE_OPTIONS: `--require ${checkout}/sk-canary.js` },
          declaredEnv: ['NODE_OPTIONS'],
        }),
      ),
      refusal(server({ env: { CERT: 'sk-canary\n' }, declaredEnv: ['CERT'] })),
    ];
    expect(reasons.every((r) => r !== null)).toBe(true);
    expect(JSON.stringify(reasons)).not.toContain('sk-canary');
    expect(JSON.stringify(reasons)).not.toContain(checkout);
  });
});

describe('launchYourMcpServers', () => {
  let filesRoot: string;
  beforeEach(() => {
    filesRoot = join(realpathSync(root.path), 'run');
    mkdirSync(filesRoot, { mode: 0o700 });
  });

  const launch = (servers: Record<string, UnsandboxedStdioServer>) =>
    launchYourMcpServers({ home, filesRoot, laneWritable, servers });

  it('writes one sealed env file per server, mode 0400, with the cleaned PATH and the home', () => {
    const launched = launch({
      a: server({
        env: { PATH: `${checkout}/bin:${loginPath()}`, TOKEN: 'sk-canary' },
        declaredEnv: ['TOKEN'],
      }),
      b: server(),
    });
    const files = readdirSync(filesRoot).sort();
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file).toMatch(/^10db-ymcp-[0-9a-f]{12}\.sh$/);
      expect(statSync(join(filesRoot, file)).mode & 0o777).toBe(0o400);
    }
    const envFile = launched.servers['a']?.launch().args[6] ?? '';
    const content = readFileSync(envFile, 'utf8');
    expect(content).toContain(`export PATH='${loginPath()}'\n`);
    expect(content).toContain(`export HOME='${home}'\n`);
    expect(content).toContain("export TOKEN='sk-canary'\n");
    launched.dispose();
  });

  it('the launch’s argv holds no env value', () => {
    const launched = launch({
      a: server({
        cwd: '/srv',
        env: { TOKEN: 'sk-canary', PATH: loginPath() },
        declaredEnv: ['TOKEN'],
      }),
    });
    const run = launched.servers['a']?.launch();
    expect(run).toEqual({
      command: '/usr/bin/env',
      args: [
        '-i',
        'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
        `HOME=${home}`,
        '/bin/sh',
        '-c',
        'cd -- "$1" && . "$0" && shift && exec "$@"',
        expect.stringMatching(/10db-ymcp-[0-9a-f]{12}\.sh$/),
        '/srv',
        'npx',
        '-y',
        'pkg',
      ],
    });
    expect(JSON.stringify(run)).not.toContain('sk-canary');
    launched.dispose();
  });

  it('a refused server has a left-out item and no file', () => {
    const launched = launch({ bad: server({ command: join(checkout, 'tool') }) });
    expect(launched.servers).toEqual({});
    expect(launched.leftOut).toEqual([
      {
        what: 'your MCP server bad',
        why: `Its command points at a project's folder${SUFFIX}`,
      },
    ]);
    expect(readdirSync(filesRoot)).toEqual([]);
  });

  it('a dropped login variable is named in a left-out item, and the server runs', () => {
    const launched = launch({ a: server({ env: { PATH: loginPath(), PEM: 'x\ny' } }) });
    expect(Object.keys(launched.servers)).toEqual(['a']);
    expect(launched.leftOut).toEqual([
      {
        what: 'your MCP server a',
        why: "it runs without PEM from your login environment, which point where an agent can write or can't be passed",
      },
    ]);
    launched.dispose();
  });

  it('dispose removes the files', () => {
    const launched = launch({ a: server(), b: server() });
    const files = readdirSync(filesRoot).map((f) => join(filesRoot, f));
    launched.dispose();
    expect(files.some(existsSync)).toBe(false);
  });
});
