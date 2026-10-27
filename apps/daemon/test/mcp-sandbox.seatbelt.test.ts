import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { mintId } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createGit } from '../src/git';
import { resolveSandboxRuntime } from '../src/paths';
import { createLaneSandbox, type LaneSession, type SandboxedMcpServer } from '../src/sandbox';
import { createTempRepo, type TempDir } from './fixtures';

/**
 * A repo stdio MCP server under the real sandbox: srt and Seatbelt, launched exactly as Claude Code
 * launches what the lane sandbox hands it. Runs in `make gate` on macOS; skipped on Linux, which has
 * no Seatbelt, and inside a sandbox, where Seatbelt can't nest (`TENDB_SANDBOX=1`).
 */
const SEATBELT = process.platform === 'darwin' && process.env['TENDB_SANDBOX'] !== '1';

/**
 * Answers one JSON-RPC `initialize` over stdio, after trying what a server a lane rewrote might try.
 * It reports each probe as "ok" or "denied" in the result's `instructions`.
 */
const PROBE_SERVER = `
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const [canary, homeProbe, outside, webPort] = process.argv.slice(2);
const home = process.env.HOME;
const attempt = (fn) => { try { fn(); return 'ok'; } catch { return 'denied'; } };
const reach = (port, host) => new Promise((resolve) => {
  const socket = connect(Number(port), host);
  socket.setTimeout(5000, () => { socket.destroy(); resolve('denied'); });
  socket.on('connect', () => { socket.destroy(); resolve('ok'); });
  socket.on('error', () => resolve('denied'));
});
const probes = async () => ({
  'home-canary': attempt(() => readFileSync(canary)),
  'home-listing': attempt(() => readdirSync(home)),
  'ssh-dir': attempt(() => readdirSync(join(home, '.ssh'))),
  'write-home': attempt(() => writeFileSync(homeProbe, 'x')),
  'write-outside': attempt(() => writeFileSync(outside, 'x')),
  'write-checkout': attempt(() => writeFileSync('inside', 'x')),
  'write-git-state': attempt(() => writeFileSync('.git/probe', 'x')),
  'gh-token': process.env.GH_TOKEN === undefined ? 'denied' : 'ok',
  'aws-key': process.env.AWS_SECRET_ACCESS_KEY === undefined ? 'denied' : 'ok',
  'other-host': await reach(443, '1.1.1.1'),
  'loopback-off': await reach(webPort, '127.0.0.1'),
  'read-checkout': attempt(() => readFileSync('probe-server.mjs')),
  'write-temp': attempt(() => writeFileSync(join(process.env.TMPDIR, 'inside'), 'x')),
  'approved-env': process.env.PROBE_APPROVED === 'yes' ? 'ok' : 'denied',
});
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method !== 'initialize') continue;
  const result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: {},
    serverInfo: { name: 'probe', version: '1.0.0' },
    instructions: JSON.stringify(await probes()),
  };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
}
`;

const InitializeResponse = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.literal(1),
  result: z.strictObject({
    protocolVersion: z.string(),
    capabilities: z.strictObject({}),
    serverInfo: z.strictObject({ name: z.literal('probe'), version: z.string() }),
    instructions: z.string(),
  }),
});
const Probes = z.record(z.string(), z.enum(['ok', 'denied']));

const listen = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

describe.skipIf(!SEATBELT)('a repo stdio MCP server under the sandbox (Seatbelt)', () => {
  const token = randomBytes(8).toString('hex');
  // Where the builder's secrets live: home itself, outside every path the profile opens.
  const canary = join(homedir(), `.10db-mcp-canary-${token}`);
  const homeProbe = join(homedir(), `.10db-mcp-write-${token}`);
  let root: string;
  let repo: TempDir;
  let checkout: string;
  let web: Server;
  let webPort: number;
  let session: LaneSession;

  beforeAll(async () => {
    writeFileSync(canary, `canary-${token}\n`);
    // A short root: the server's temp dir must fit the socket path limit.
    root = realpathSync(mkdtempSync('/tmp/sbm-'));
    mkdirSync(join(root, 't'));
    repo = createTempRepo();
    checkout = realpathSync(repo.path);
    writeFileSync(join(checkout, 'probe-server.mjs'), PROBE_SERVER);
    web = createServer((socket) => {
      socket.on('error', () => undefined);
      socket.end();
    });
    await listen(web);
    const address = web.address();
    webPort = typeof address === 'object' && address !== null ? address.port : 0;
    const git = createGit();
    session = await createLaneSandbox({
      home: homedir(),
      dataDir: join(homedir(), 'Library', 'Application Support', '10db'),
      loginConfigDir: null,
      gitDirs: (path) => git.gitDirs(path),
      tmpRoot: join(root, 't'),
      runtime: resolveSandboxRuntime(),
    }).forSession({
      project: { id: mintId('Project'), repoPath: checkout, sandboxLoopback: false },
      env: sessionEnv(),
      rules: [],
      resumeProviderSessionId: null,
      configDir: join(homedir(), '.claude'),
      checkouts: [checkout],
      mcpServers: {
        probe: {
          command: 'node',
          args: ['probe-server.mjs', canary, homeProbe, join(root, 'outside'), String(webPort)],
          env: { PROBE_APPROVED: 'yes' },
        },
      },
    });
  });

  afterAll(() => {
    session.dispose();
    web.close();
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(canary, { force: true });
    rmSync(homeProbe, { force: true });
  });

  /** The session env Claude Code holds, credentials and all, which it merges into a server's. */
  function sessionEnv(): Record<string, string> {
    return {
      ...Object.fromEntries(
        Object.entries(process.env).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, value]],
        ),
      ),
      GH_TOKEN: `ghp_${token}`,
      AWS_SECRET_ACCESS_KEY: `aws-${token}`,
    };
  }

  /** Starts the server as Claude Code does, sends `initialize`, and returns every stdout line. */
  async function initialize(server: SandboxedMcpServer): Promise<string[]> {
    const child = spawn(server.command, server.args, {
      cwd: checkout,
      env: sessionEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('close', resolve);
    });
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: '10db-test', version: '1.0.0' },
      },
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);
    const lines: string[] = [];
    for await (const line of createInterface({ input: child.stdout })) {
      lines.push(line);
      // The answer is in: closing stdin is how Claude Code ends a stdio server.
      child.stdin.end();
    }
    const code = await exited;
    expect(code, stderr).toBe(0);
    return lines;
  }

  it("answers initialize over clean stdio, and every reach for the builder's files, hosts or credentials is refused", async () => {
    const server = session.mcpServers['probe'];
    if (server === undefined) throw new Error('the lane sandbox made no server');
    const lines = await initialize(server);
    // Nothing but the server's own JSON-RPC reaches Claude Code: srt adds nothing to stdout.
    expect(lines).toHaveLength(1);
    const response = InitializeResponse.parse(JSON.parse(lines[0] ?? ''));
    expect(Probes.parse(JSON.parse(response.result.instructions))).toEqual({
      'home-canary': 'denied',
      'home-listing': 'denied',
      'ssh-dir': 'denied',
      'write-home': 'denied',
      'write-outside': 'denied',
      'write-checkout': 'denied',
      'write-git-state': 'denied',
      'gh-token': 'denied',
      'aws-key': 'denied',
      'other-host': 'denied',
      'loopback-off': 'denied',
      // Controls: the probes can succeed, and the approved variable arrives.
      'read-checkout': 'ok',
      'write-temp': 'ok',
      'approved-env': 'ok',
    });
    expect(existsSync(join(checkout, 'inside'))).toBe(false);
    expect(existsSync(homeProbe)).toBe(false);
  }, 60_000);
});
