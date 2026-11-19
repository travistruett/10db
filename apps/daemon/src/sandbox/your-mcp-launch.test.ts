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
import { homeOutsideTemp, type TempDir } from '../../test/fixtures';
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
  root = homeOutsideTemp('your-mcp-launch');
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
  it('allows a server that names nothing an agent can write', () => {
    const run = prepare(server());
    expect(run.refusal, 'npx -y pkg from the home').toBeNull();
    expect(run.env['HOME']).toBe(home);
    expect(run.dropped).toEqual([]);
    for (const [name, over] of [
      ['a missing command by its path', { command: join(home, 'bin', 'missing') }],
      ['a missing command by its name', { command: 'missing' }],
      ['an argument that only looks like a word', { args: ['run', 'tmp', 'lanes', '--port=3000'] }],
    ] as const) {
      expect.soft(refusal(server(over)), name).toBeNull();
    }
  });

  it('refuses a server whose command, argument, folder or declared env points where an agent can write', () => {
    const rows: [string, () => Partial<UnsandboxedStdioServer>, string][] = [
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
      ...[
        'KUBECONFIG',
        'AWS_CONFIG_FILE',
        'DOCKER_CONFIG',
        'XDG_CONFIG_HOME',
        'PYTHONUSERBASE',
        'PYTHONPYCACHEPREFIX',
        'MISE_CONFIG_DIR',
      ].map((name): [string, () => Partial<UnsandboxedStdioServer>, string] => [
        `a declared ${name} into a checkout is refused`,
        () => ({
          env: { ...server().env, [name]: `${checkout}/x` },
          declaredEnv: [name],
        }),
        `Its ${name} points at a project's folder${SUFFIX}`,
      ]),
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
        'a link into a checkout folder followed by .. is judged where the kernel opens it',
        () => {
          mkdirSync(join(checkout, 'sub'), { recursive: true });
          symlinkSync(join(checkout, 'sub'), join(home, 'deep'));
          return { args: ['deep/../server.js'] };
        },
        `Its argument 1 points at a project's folder${SUFFIX}`,
      ],
      [
        'the same through a link inside an option value',
        () => {
          mkdirSync(join(checkout, 'sub'), { recursive: true });
          symlinkSync(join(checkout, 'sub'), join(home, 'deep-2'));
          return { args: ['--config=deep-2/../x.json'] };
        },
        `Its argument 1 points at a project's folder${SUFFIX}`,
      ],
      [
        'a flag letter glued to a relative path that climbs into a checkout is refused',
        () => ({ args: ['-I../checkout'] }),
        `Its argument 1 points at a project's folder${SUFFIX}`,
      ],
      [
        'a long flag glued to a relative path that climbs into a checkout is refused',
        () => ({ args: ['--include../checkout/inc'] }),
        `Its argument 1 points at a project's folder${SUFFIX}`,
      ],
      [
        'a flag letter glued to a relative path through a link into a checkout is refused',
        () => {
          symlinkSync(checkout, join(home, 'linked-dir-2'));
          return { args: ['-rlinked-dir-2/x.js'] };
        },
        `Its argument 1 points at a project's folder${SUFFIX}`,
      ],
      [
        'a declared NODE_OPTIONS with a flag glued to a relative path is refused',
        () => ({
          env: { ...server().env, NODE_OPTIONS: '-r../checkout/x.js' },
          declaredEnv: ['NODE_OPTIONS'],
        }),
        `Its NODE_OPTIONS points at a project's folder${SUFFIX}`,
      ],
      [
        'a declared variable with a newline refuses the server',
        () => ({ env: { ...server().env, CERT: 'a\nb' }, declaredEnv: ['CERT'] }),
        "Its env variable CERT can't be passed to it.",
      ],
    ];
    // Only where the file system folds case does a checkout path spelled in another case reach it.
    if (process.platform === 'darwin') {
      const shouted = (): string => join(checkout.toUpperCase(), 'server.js');
      rows.push(
        [
          'a checkout path spelled in another case is refused',
          () => ({ args: [shouted()] }),
          `Its argument 1 points at a project's folder${SUFFIX}`,
        ],
        [
          'a checkout path spelled in another case inside an option is refused',
          () => ({ args: [`--opt=a,${shouted()}`] }),
          `Its argument 1 points at a project's folder${SUFFIX}`,
        ],
      );
    }
    for (const [name, over, reason] of rows) {
      expect.soft(refusal(server(over())), name).toBe(reason);
    }
  });

  it("drops and names a login variable that points where an agent can write or can't be passed; the server runs", () => {
    for (const [name, value] of [
      ['NODE_OPTIONS', `--require "${checkout}/x.js"`],
      ['PYTHONPATH', `${checkout}/src`],
      ['PEM', 'line1\nline2'],
    ] as const) {
      const run = prepare(server({ env: { ...server().env, [name]: value } }));
      expect.soft(run.refusal, name).toBeNull();
      expect.soft(run.env, name).not.toHaveProperty(name);
      expect.soft(run.dropped, name).toEqual([name]);
    }
  });

  it('drops every PATH entry in a checkout or relative, and uses the host PATH when there is none', () => {
    for (const [name, path, expected] of [
      [
        'a checkout entry, existing or not',
        `${checkout}/node_modules/.bin:${checkout}/not-yet:${loginPath()}`,
        loginPath(),
      ],
      ['a relative entry', `node_modules/.bin:./bin:${loginPath()}`, loginPath()],
      ['no PATH', undefined, '/usr/bin:/bin:/usr/sbin:/sbin'],
    ] as const) {
      const env = path === undefined ? {} : { PATH: path };
      expect.soft(prepare(server({ env })).env['PATH'], name).toBe(expected);
    }
    // A bare name whose only PATH match is in a checkout is not found, not run.
    const run = prepare(
      server({
        command: 'only-here',
        env: { PATH: `${checkout}/node_modules/.bin:${loginPath()}` },
      }),
    );
    expect(run.refusal).toBeNull();
    expect(run.env['PATH']).toBe(loginPath());
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

  it('writes one sealed env file per server, mode 0400, with the cleaned PATH and the home, and dispose removes them', () => {
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
    expect(files.map((f) => join(filesRoot, f)).some(existsSync)).toBe(false);
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

  it('leaves a refused server out with no file, and runs one with a dropped login variable, naming each', () => {
    const launched = launch({
      bad: server({ command: join(checkout, 'tool') }),
      a: server({ env: { PATH: loginPath(), PEM: 'x\ny' } }),
    });
    expect(Object.keys(launched.servers)).toEqual(['a']);
    expect(launched.leftOut).toEqual([
      {
        what: 'your MCP server bad',
        why: `Its command points at a project's folder${SUFFIX}`,
      },
      {
        what: 'your MCP server a',
        why: "it runs without PEM from your login environment, which point where an agent can write or can't be passed",
      },
    ]);
    // Only the server that runs has a file.
    expect(readdirSync(filesRoot)).toHaveLength(1);
    launched.dispose();
  });
});
