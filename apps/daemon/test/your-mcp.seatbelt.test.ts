import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { mintId } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createGit } from '../src/git';
import { resolveSandboxRuntime } from '../src/paths';
import { createLaneSandbox, type LaneSession } from '../src/sandbox';
// The settings srt reads for a profile, as the gate and the repo servers hand it over.
import { srtSettings } from '../src/sandbox/srt-settings';
import { createTempRepo, type TempDir } from './fixtures';

/**
 * A builder's MCP server runs outside the sandbox, beside a lane whose commands run under srt and
 * Seatbelt. A lane command must not read the server's environment, its arguments or its sealed env file.
 * Runs in `make gate` on macOS; skipped on Linux, which has no Seatbelt, and inside a sandbox, where
 * Seatbelt can't nest (`TENDB_SANDBOX=1`).
 */
const SEATBELT = process.platform === 'darwin' && process.env['TENDB_SANDBOX'] !== '1';

/** Reads a canary in the home, says so with its pid, then stays up until its stdin closes. */
const SERVER = `
import { readFileSync } from 'node:fs';
const canary = process.argv[2];
let read = 'denied';
try { readFileSync(canary); read = 'ok'; } catch {}
process.stdout.write(JSON.stringify({ pid: process.pid, read }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

const Started = z.strictObject({ pid: z.number().int().positive(), read: z.string() });

describe.skipIf(!SEATBELT)("a builder's MCP server beside a lane (Seatbelt)", () => {
  const token = randomBytes(8).toString('hex');
  const home = homedir();
  // Where the builder's files live: the home, outside every path a lane's profile opens.
  const canary = join(home, `.10db-ymcp-canary-${token}`);
  const script = join(home, `.10db-ymcp-server-${token}.mjs`);
  let root: string;
  let repo: TempDir;
  let session: LaneSession;
  let server: ChildProcess;
  let pid: number;
  let read: string;

  beforeAll(async () => {
    writeFileSync(canary, `canary-${token}\n`);
    writeFileSync(script, SERVER);
    // A short root: the lane temp dir's whole path must fit Claude Code's limit.
    root = realpathSync(mkdtempSync('/tmp/sby-'));
    mkdirSync(join(root, 't'));
    mkdirSync(join(root, 'r'));
    repo = createTempRepo();
    const git = createGit();
    session = await createLaneSandbox({
      home,
      dataDir: join(home, 'Library', 'Application Support', '10db'),
      loginConfigDir: null,
      gitDirs: (path) => git.gitDirs(path),
      tmpRoot: join(root, 't'),
      filesRoot: join(root, 'r'),
      runtime: resolveSandboxRuntime(),
      worktreeRoot: join(root, 'w'),
    }).forSession({
      project: {
        id: mintId('Project'),
        repoPath: realpathSync(repo.path),
        sandboxLoopback: false,
        gateCommand: 'make gate',
      },
      env: { PATH: '/usr/bin:/bin', HOME: home },
      rules: [],
      resumeProviderSessionId: null,
      configDir: join(home, '.claude'),
      checkouts: [realpathSync(repo.path)],
      mcpServers: {},
      yourMcpServers: {
        probe: {
          command: process.execPath,
          args: [script, canary, '--marker=arg-canary'],
          cwd: null,
          env: { PATH: '/usr/bin:/bin', TOKEN: 'sk-canary' },
          declaredEnv: ['TOKEN'],
        },
      },
    });
    const launch = session.yourMcpServers?.['probe']?.launch();
    if (launch === undefined)
      throw new Error(`no launch: ${JSON.stringify(session.yourMcpLeftOut)}`);
    // Started as Claude Code starts it: from the checkout, with the session's environment.
    server = spawn(launch.command, launch.args, {
      cwd: realpathSync(repo.path),
      env: { ...process.env, ANTHROPIC_API_KEY: `sk-session-${token}` },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    if (server.stdout === null) throw new Error('no stdout');
    for await (const line of createInterface({ input: server.stdout })) {
      ({ pid, read } = Started.parse(JSON.parse(line)));
      break;
    }
  }, 60_000);

  afterAll(async () => {
    server.stdin?.end();
    server.kill();
    await session.dispose();
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(canary, { force: true });
    rmSync(script, { force: true });
  });

  /** Runs `command` under the session's profile through srt, with its exit status and output. */
  function lane(command: string): { ok: boolean; out: string } {
    const settings = join(root, `settings-${randomBytes(4).toString('hex')}.json`);
    writeFileSync(settings, JSON.stringify(srtSettings(session.spec.settings)));
    const runtime = resolveSandboxRuntime();
    const ran = spawnSync(runtime.node, [runtime.cli, '--settings', settings, '-c', command], {
      cwd: realpathSync(repo.path),
      env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CODE_TMPDIR: session.tmpDir },
      encoding: 'utf8',
      timeout: 30_000,
    });
    rmSync(settings, { force: true });
    return { ok: ran.status === 0, out: `${ran.stdout}${ran.stderr}` };
  }

  const shows = (out: string, canaryText: string): 'ok' | 'denied' =>
    out.includes(canaryText) ? 'ok' : 'denied';

  it("keeps a lane off the server's env, args and env file, while the server reads the home", () => {
    const envFile = session.yourMcpServers?.['probe']?.launch().args[6] ?? '';
    expect(existsSync(envFile)).toBe(true);
    // Positive controls, outside the sandbox: the probes can see what they look for.
    const psEnv = spawnSync('/bin/ps', ['-E', '-p', String(pid)], { encoding: 'utf8' });
    expect(shows(psEnv.stdout, 'sk-canary')).toBe('ok');
    const psArgs = spawnSync('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    expect(shows(psArgs.stdout, 'arg-canary')).toBe('ok');
    // The session's own credential never reached the server.
    expect(psEnv.stdout).not.toContain(`sk-session-${token}`);

    expect(() => process.kill(pid, 0)).not.toThrow();
    const results = {
      'server-read-home-canary': read,
      'lane-ps-env': shows(lane(`/bin/ps -E -p ${String(pid)}`).out, 'sk-canary'),
      'lane-ps-args': shows(lane(`/bin/ps -ww -o args= -p ${String(pid)}`).out, 'arg-canary'),
      'lane-read-env-file': lane(`cat '${envFile}'`).ok ? 'ok' : 'denied',
      // Where the home has no such file this row proves nothing; the builder's Mac has one.
      'lane-read-claude-json':
        existsSync(join(home, '.claude.json')) && lane(`cat '${join(home, '.claude.json')}'`).ok
          ? 'ok'
          : 'denied',
      'lane-write-files-root': lane(`touch '${join(root, 'r', 'x')}'`).ok ? 'ok' : 'denied',
    };
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(results).toEqual({
      'server-read-home-canary': 'ok',
      'lane-ps-env': 'denied',
      'lane-ps-args': 'denied',
      'lane-read-env-file': 'denied',
      'lane-read-claude-json': 'denied',
      'lane-write-files-root': 'denied',
    });
  }, 60_000);
});
