import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { laneWritableRoots, launchYourMcpServers } from '../src/sandbox';
import { tempDir, type TempDir } from './fixtures';

// A builder's MCP server runs outside the sandbox, started by Claude Code with Claude Code's own
// environment. The launch must hand it only its own env, from the home.

let root: TempDir;
let home: string;
let checkout: string;
let filesRoot: string;

beforeEach(() => {
  root = tempDir('your-mcp-process');
  const base = realpathSync(root.path);
  home = join(base, 'home');
  checkout = join(base, 'checkout');
  filesRoot = join(base, 'run');
  mkdirSync(home);
  mkdirSync(join(checkout, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(filesRoot, { mode: 0o700 });
});

afterEach(() => {
  root.cleanup();
});

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${String(code)}: ${err}`));
    });
  });
}

describe('a launched builder MCP server', () => {
  it('starts from the home with its own env, none of Claude Code’s, and no checkout on PATH', async () => {
    const script = join(home, 'server.mjs');
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: process.env }));\n',
    );
    const laneWritable = laneWritableRoots({
      checkouts: [checkout],
      worktreeBase: join(home, 'worktrees'),
      sandboxTempRoots: [],
      systemTempRoots: ['/private/tmp', '/private/var/tmp'],
    });
    const launched = launchYourMcpServers({
      home,
      filesRoot,
      laneWritable,
      servers: {
        probe: {
          command: process.execPath,
          args: [script],
          cwd: null,
          env: {
            PATH: `${checkout}/node_modules/.bin:/usr/bin:/bin`,
            TOKEN: 'declared-token',
          },
          declaredEnv: ['TOKEN'],
        },
      },
    });
    try {
      const launch = launched.servers['probe']?.launch();
      if (launch === undefined) throw new Error('no launch');
      const out = await run(launch.command, launch.args, checkout, {
        ...process.env,
        ANTHROPIC_API_KEY: 'sk-canary',
        TENDB_MCP_TOKEN: 'tok-canary',
      });
      const seen = JSON.parse(out) as { cwd: string; env: Record<string, string> }; // the script's own JSON
      expect(seen.cwd).toBe(home);
      expect(seen.env['TOKEN']).toBe('declared-token');
      expect(seen.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(seen.env).not.toHaveProperty('TENDB_MCP_TOKEN');
      expect(seen.env['PATH']).toBe('/usr/bin:/bin');
      expect(seen.env['HOME']).toBe(home);
    } finally {
      launched.dispose();
    }
  });
});
