import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTempRepo, FAKE_SRT, SANDBOXED, type TempDir } from '../../test/fixtures';
import { createGit } from '../git';
import {
  createLaneSandbox,
  SandboxProfileError,
  type LaneSession,
  type LaneSessionInput,
  type SandboxRuntime,
} from './index';

const git = createGit();
const Paths = z.array(z.string());
const SrtFile = z.looseObject({
  filesystem: z.strictObject({
    allowWrite: Paths,
    denyWrite: Paths,
    denyRead: Paths,
    allowRead: Paths,
  }),
});
const projectId = mintId('Project');

let root: string;
let home: string;
let tmpRoot: string;
let repo: TempDir;
let checkout: string;

const SERVER = { command: 'node', args: ['scripts/mcp.mjs', "it's"], env: { DOCS_TOKEN: 'tok-1' } };

function forSession(
  overrides: Partial<LaneSessionInput> = {},
  runtime: SandboxRuntime = FAKE_SRT,
): Promise<LaneSession> {
  return createLaneSandbox({
    home,
    dataDir: join(home, 'data'),
    loginConfigDir: null,
    tmpRoot,
    gitDirs: (path) => git.gitDirs(path),
    systemPrefixes: [],
    runtime,
  }).forSession({
    project: { id: projectId, repoPath: repo.path, sandboxLoopback: false },
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      LANG: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      GH_TOKEN: 'ghp-x',
      AWS_SECRET_ACCESS_KEY: 'aws-x',
    },
    rules: [{ toolName: 'SandboxNetworkAccess', pattern: 'registry.npmjs.org' }],
    resumeProviderSessionId: null,
    configDir: join(home, '.claude'),
    checkouts: [repo.path],
    mcpServers: { docs: SERVER },
    ...overrides,
  });
}

/** What the session hands Claude Code for `name`, split into its parts. */
function launchOf(session: LaneSession, name: string) {
  const made = session.mcpServers[name];
  if (made === undefined) throw new Error(`no ${name} server`);
  const server = made.launch();
  const at = server.args.indexOf('--settings');
  const settingsFile = server.args[at + 1] ?? '';
  const inner = server.args.at(-1) ?? '';
  const tmp = server.args.find((arg) => arg.startsWith('CLAUDE_CODE_TMPDIR='))?.split('=')[1];
  if (tmp === undefined) throw new Error('no temp dir');
  const envFile = /'\. "\$0" && exec "\$@"' '([^']+)'/.exec(inner)?.[1];
  if (envFile === undefined) throw new Error(`no env file in ${inner}`);
  const settings: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'));
  return { server, settingsFile, settings, inner, tmp, envFile };
}

beforeEach(() => {
  // A short root: a temp dir's whole path must fit the socket path limit.
  root = realpathSync(mkdtempSync('/tmp/sbm-'));
  home = join(root, 'home');
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

describe.skipIf(SANDBOXED)("a lane session's repo stdio MCP servers", () => {
  it('launches every one through env -i and srt, so Claude Code never starts the command itself', async () => {
    const session = await forSession({
      mcpServers: { docs: SERVER, other: { command: 'uvx', args: ['x'], env: {} } },
    });
    try {
      expect(Object.keys(session.mcpServers)).toEqual(['docs', 'other']);
      const { server, settingsFile, tmp, inner } = launchOf(session, 'docs');
      expect(server).toEqual({
        command: '/usr/bin/env',
        args: [
          '-i',
          'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
          `HOME=${home}`,
          `CLAUDE_CODE_TMPDIR=${tmp}`,
          FAKE_SRT.node,
          FAKE_SRT.cli,
          '--settings',
          settingsFile,
          '-c',
          inner,
        ],
      });
      // The command is srt's own child, with nothing but the sealed file's env.
      expect(inner).toMatch(/^exec \/usr\/bin\/env -i \/bin\/sh -c /);
      expect(inner.endsWith(` 'node' 'scripts/mcp.mjs' 'it'\\''s'`)).toBe(true);
      // Its own temp dir, apart from the lane's and the other server's.
      expect(tmp).not.toBe(session.tmpDir);
      expect(launchOf(session, 'other').tmp).not.toBe(tmp);
      expect(tmp.startsWith(`${tmpRoot}/`)).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it('puts no value on a command line: the approved variables travel in a sealed file', async () => {
    const session = await forSession();
    try {
      const { server, envFile, tmp } = launchOf(session, 'docs');
      expect(JSON.stringify(server)).not.toContain('tok-1');
      expect(statSync(envFile).mode & 0o777).toBe(0o400);
      const text = readFileSync(envFile, 'utf8');
      const names = [...text.matchAll(/^export ([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]);
      expect(names).toEqual(
        expect.arrayContaining(['PATH', 'HOME', 'LANG', 'TMPDIR', 'DOCS_TOKEN', 'TENDB_SANDBOX']),
      );
      for (const secret of ['ANTHROPIC_API_KEY', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY'])
        expect(names).not.toContain(secret);
      expect(text).toContain("export DOCS_TOKEN='tok-1'");
      expect(text).toContain(`export TMPDIR='${tmp}'`);
    } finally {
      session.dispose();
    }
  });

  it('writes only its own temp dir, never the checkout, and reads the env file it is given', async () => {
    const session = await forSession();
    try {
      const { settings, tmp, envFile } = launchOf(session, 'docs');
      const { filesystem } = SrtFile.parse(settings);
      expect(filesystem.allowWrite).toEqual([tmp]);
      expect(filesystem.denyWrite).toEqual(
        expect.arrayContaining(['/tmp/claude', '/private/tmp/claude']),
      );
      expect(filesystem.denyRead).toEqual(expect.arrayContaining(['/', join(home, '.claude')]));
      expect(filesystem.allowRead).toEqual(expect.arrayContaining([checkout, tmp, envFile]));
      expect(settings).toMatchObject({ allowAppleEvents: false });
    } finally {
      session.dispose();
    }
  });

  it.each([
    ['off', false],
    ['on', true],
  ])(
    "reaches no host, not even the project's or localhost, with the project's loopback %s",
    async (_name, loopback) => {
      const session = await forSession({
        project: { id: projectId, repoPath: repo.path, sandboxLoopback: loopback },
      });
      try {
        // The lane's own commands still reach the project's hosts, and localhost by its switch.
        expect(session.spec.settings.network.allowedDomains).toEqual(['registry.npmjs.org']);
        expect(session.spec.settings.network.allowLocalBinding ?? false).toBe(loopback);
        const { settings, tmp } = launchOf(session, 'docs');
        // No local binding: loopback would reach other sandboxes' proxies, and through them hosts.
        expect(settings).toEqual(
          expect.objectContaining({
            network: {
              allowedDomains: [],
              deniedDomains: [],
              strictAllowlist: true,
              allowMachLookup: ['com.apple.FSEvents'],
              allowUnixSockets: [tmp],
            },
          }),
        );
      } finally {
        session.dispose();
      }
    },
  );

  it('leaves out a server whose approved value it cannot seal, naming it, and starts the rest', async () => {
    const session = await forSession({
      mcpServers: {
        broken: { command: 'node', args: ['x.mjs'], env: { DOCS_TOKEN: 'line-one\nline-two' } },
        docs: SERVER,
      },
    });
    try {
      expect(Object.keys(session.mcpServers)).toEqual(['docs']);
      expect(session.mcpFailures.map((failure) => failure.name)).toEqual(['broken']);
      expect(session.mcpFailures[0]?.message).toContain('DOCS_TOKEN');
      // The value itself is never in the report.
      expect(JSON.stringify(session.mcpFailures)).not.toContain('line-one');
      const { settingsFile, tmp, envFile } = launchOf(session, 'docs');
      // Only the lane's own files and the started server's are left: the failed one's are gone.
      expect(readdirSync(tmpRoot).sort()).toEqual(
        [session.tmpDir, settingsFile, tmp, envFile, session.spec.env['CLAUDE_ENV_FILE'] ?? '']
          .map((path) => path.slice(tmpRoot.length + 1))
          .sort(),
      );
    } finally {
      session.dispose();
    }
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('removes each server temp dir, settings file and env file on dispose', async () => {
    const session = await forSession();
    const { settingsFile, tmp, envFile } = launchOf(session, 'docs');
    session.dispose();
    for (const path of [settingsFile, tmp, envFile]) expect(existsSync(path)).toBe(false);
    expect(existsSync(session.tmpDir)).toBe(false);
  });

  it('refuses the session when srt lies where a project can write, and leaves nothing behind', async () => {
    await expect(
      forSession({}, { node: process.execPath, cli: join(checkout, 'srt.mjs') }),
    ).rejects.toThrow(SandboxProfileError);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('makes nothing and checks no srt when the repo has no stdio server', async () => {
    const session = await forSession(
      { mcpServers: {} },
      { node: process.execPath, cli: join(checkout, 'srt.mjs') },
    );
    try {
      expect(session.mcpServers).toEqual({});
    } finally {
      session.dispose();
    }
  });
});
