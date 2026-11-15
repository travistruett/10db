import { chmodSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../clock';
import { tempDir, type TempDir } from '../../test/fixtures';
import { silentLogger } from '../log';
import {
  CONNECTOR_POLL_MS,
  CONNECTOR_PROBE_MS,
  CONNECTOR_RETRY_MS,
  CONNECTOR_TTL_MS,
  connectorsForSession,
  ConnectorProbeRefusedError,
  connectorsFromStatus,
  createConnectorDirectory,
  sweepConnectorProbeRoot,
  type ClaudeConnector,
} from './claude-connectors';
import type { QueryFn } from './claude-session';

const proxy = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  status: 'connected',
  scope: 'claudeai',
  config: { type: 'claudeai-proxy', url: `https://mcp.claude.ai/${name}`, id: `id-${name}` },
  ...over,
});

describe('connectorsFromStatus', () => {
  it.each<[string, unknown, ClaudeConnector[] | null]>([
    [
      'keeps a claudeai-proxy entry',
      [proxy('claude.ai Gmail')],
      [
        {
          name: 'claude.ai Gmail',
          url: 'https://mcp.claude.ai/claude.ai Gmail',
          id: 'id-claude.ai Gmail',
        },
      ],
    ],
    [
      'drops an http url',
      [proxy('a', { config: { type: 'claudeai-proxy', url: 'http://x.example', id: 'i' } })],
      [],
    ],
    [
      'drops an entry with no id',
      [proxy('a', { config: { type: 'claudeai-proxy', url: 'https://x.example' } })],
      [],
    ],
    ['drops a dynamic entry', [proxy('a', { scope: 'dynamic' })], []],
    ['reads a user entry as a failed probe', [proxy('a'), proxy('b', { scope: 'user' })], null],
    ['reads a managed entry as a failed probe', [proxy('b', { scope: 'managed' })], null],
    ['reads an entry with no scope as a failed probe', [proxy('b', { scope: undefined })], null],
    ['reads a list that is not a list as a failed probe', { servers: [] }, null],
  ])('%s', (_name, status, expected) => {
    expect(connectorsFromStatus(status)).toEqual(expected);
  });
});

describe('connectorsForSession', () => {
  it('drops a connector whose tool prefix a configured server holds', () => {
    const gmail = { name: 'claude.ai Gmail', url: 'https://x.example', id: 'g' };
    const docs = { name: 'claude.ai Docs', url: 'https://y.example', id: 'd' };
    expect(connectorsForSession([gmail, docs], ['claude_ai_Gmail', 'other'])).toEqual([docs]);
  });
});

interface Probe {
  options: Options;
  closed: number;
  polls: number;
  prompts: SDKUserMessage[];
}

let root: TempDir;
beforeEach(() => {
  root = tempDir('connectors');
});
afterEach(() => {
  root.cleanup();
});

/**
 * Moves the clock `steps` times by `stepMs`, each time once the probe has its timers: the deadline's, and
 * for a poll the next one's. The probe makes its folders first, which takes real I/O turns.
 */
async function run(clock: ManualClock, steps: number, stepMs: number, timers = 1): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    await vi.waitFor(() => {
      expect(clock.pendingTimers()).toBeGreaterThanOrEqual(timers);
    });
    clock.advance(stepMs);
  }
}

function setup(
  answers: readonly unknown[],
  hold = false,
  over: { probeRoot?: string; managedMcpPath?: string } = {},
) {
  const clock = new ManualClock();
  const probes: Probe[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    const probe: Probe = { options, closed: 0, polls: 0, prompts: [] };
    probes.push(probe);
    void (async () => {
      for await (const message of prompt) probe.prompts.push(message);
    })();
    return {
      mcpServerStatus: () => {
        const answer = answers[Math.min(probe.polls, answers.length - 1)];
        probe.polls += 1;
        if (hold) return new Promise(() => undefined);
        return answer === 'throw' ? Promise.reject(new Error('boom')) : Promise.resolve(answer);
      },
      close: () => {
        probe.closed += 1;
      },
    } as unknown as Query;
  };
  const directory = createConnectorDirectory({
    query,
    claudePath: '/usr/local/bin/claude',
    probeRoot: over.probeRoot ?? join(root.path, 'connector-probe'),
    // No managed file unless a row makes one: the builder's own must not decide a row.
    managedMcpPath: over.managedMcpPath ?? join(root.path, 'no-managed-mcp.json'),
    clock,
    logger: silentLogger,
  });
  return { clock, probes, directory };
}

const account = mintId('Account');
const env = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/d/acc' };
const rootEntries = (): string[] => {
  try {
    return readdirSync(join(root.path, 'connector-probe'));
  } catch {
    return [];
  }
};

describe('the connector directory', () => {
  it('starts Claude Code non-strict with no settings, a fresh folder and cwd, and never sends a prompt', async () => {
    const { probes, directory } = setup([[proxy('claude.ai Gmail')]]);
    const listed = directory.list(account, env);
    expect(await listed).toHaveLength(1);
    const options = probes[0]?.options;
    expect(options).toMatchObject({ strictMcpConfig: false, settingSources: [] });
    expect(options?.env).toMatchObject({
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/d/acc',
    });
    const fresh = options?.env?.['CLAUDE_CONFIG_DIR'] ?? '';
    const base = join(root.path, 'connector-probe');
    expect(fresh.startsWith(base)).toBe(true);
    expect((options?.cwd ?? '').startsWith(base)).toBe(true);
    expect(probes[0]?.prompts).toEqual([]);
    expect(probes[0]?.closed).toBe(1);
    expect(rootEntries()).toEqual([]);
    expect(statSync(base).mode & 0o777).toBe(0o700);
  });

  it('reads the default folder as the empty string', async () => {
    const { probes, directory } = setup([[proxy('a')]]);
    const listed = directory.list(account, { PATH: '/usr/bin' });
    await listed;
    expect(probes[0]?.options.env?.['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe('');
  });

  it('polls the list every 500 ms until the connectors are all there', async () => {
    const { clock, probes, directory } = setup([
      [],
      [proxy('a', { status: 'pending' })],
      [proxy('a'), proxy('b')],
    ]);
    const listed = directory.list(account, env);
    await run(clock, 2, CONNECTOR_POLL_MS, 2);
    expect((await listed)?.map((c) => c.name)).toEqual(['a', 'b']);
    expect(probes[0]?.polls).toBe(3);
    expect(probes[0]?.closed).toBe(1);
  });

  it('answers none at the deadline when the list never holds a connector', async () => {
    const { clock, probes, directory } = setup([[]]);
    const listed = directory.list(account, env);
    await run(clock, CONNECTOR_PROBE_MS / CONNECTOR_POLL_MS, CONNECTOR_POLL_MS, 2);
    expect(await listed).toEqual([]);
    expect(probes[0]?.closed).toBe(1);
    expect(rootEntries()).toEqual([]);
  });

  it('answers failed when the CLI never answers the list', async () => {
    const { clock, probes, directory } = setup([[]], true);
    const listed = directory.list(account, env);
    await run(clock, 1, CONNECTOR_PROBE_MS);
    expect(await listed).toBeNull();
    expect(probes[0]?.closed).toBe(1);
  });

  it('answers failed when the list throws, and when it holds another scope', async () => {
    for (const answer of ['throw', [proxy('a'), proxy('u', { scope: 'user' })]] as const) {
      const { probes, directory } = setup([answer]);
      const listed = directory.list(account, env);
      expect(await listed).toBeNull();
      expect(probes[0]?.closed).toBe(1);
      expect(rootEntries()).toEqual([]);
    }
  });

  it('keeps an answer for the TTL and a failure for the retry time, with one probe for two callers', async () => {
    const ok = setup([[proxy('a')]]);
    const both = Promise.all([ok.directory.list(account, env), ok.directory.list(account, env)]);
    await both;
    expect(ok.probes).toHaveLength(1);
    await ok.directory.list(account, env);
    expect(ok.probes).toHaveLength(1);
    ok.clock.advance(CONNECTOR_TTL_MS + 1);
    const again = ok.directory.list(account, env);
    await again;
    expect(ok.probes).toHaveLength(2);

    const bad = setup(['throw']);
    const first = bad.directory.list(account, env);
    expect(await first).toBeNull();
    expect(await bad.directory.list(account, env)).toBeNull();
    expect(bad.probes).toHaveLength(1);
    bad.clock.advance(CONNECTOR_RETRY_MS + 1);
    const retried = bad.directory.list(account, env);
    await retried;
    expect(bad.probes).toHaveLength(2);
  });

  it('closes a probe in flight on stop', async () => {
    const { clock, probes, directory } = setup([[]]);
    const listed = directory.list(account, env);
    await run(clock, 1, CONNECTOR_POLL_MS, 2);
    await directory.stop();
    expect(await listed).toBeNull();
    expect(probes[0]?.closed).toBe(1);
    expect(rootEntries()).toEqual([]);
  });
});

describe('a folder above the probe that holds MCP servers', () => {
  // Claude Code reads a `.mcp.json` in the cwd and every folder above it, and a non-strict probe would start
  // the servers in it before the list is read: so the probe never starts under one.
  it.each<{ name: string; make: (dir: string) => string | undefined }>([
    {
      name: 'the folder holding the probe root',
      make: (dir) => {
        writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{}}');
        return undefined;
      },
    },
    {
      name: 'the probe root itself',
      make: (dir) => {
        mkdirSync(join(dir, 'connector-probe'), { recursive: true });
        writeFileSync(join(dir, 'connector-probe', '.mcp.json'), '{}');
        return undefined;
      },
    },
    {
      name: 'the managed file',
      make: (dir) => {
        const managed = join(dir, 'managed-mcp.json');
        writeFileSync(managed, '{}');
        return managed;
      },
    },
  ])('is refused, as a failed read and with no start: $name', async ({ make }) => {
    const managedMcpPath = make(root.path);
    const { probes, directory } = setup([[proxy('a')]], false, {
      ...(managedMcpPath === undefined ? {} : { managedMcpPath }),
    });
    expect(await directory.list(account, env)).toBeNull();
    expect(probes).toHaveLength(0);
    // Nothing is left in the probe root but what a row put there.
    expect(rootEntries().filter((name) => name.startsWith('probe-'))).toEqual([]);
    // Kept as a failure for the retry time, not asked again.
    expect(await directory.list(account, env)).toBeNull();
    expect(probes).toHaveLength(0);
  });

  it.each(['.mcp.json', 'managed-mcp.json'])('names the config that refused it', async (file) => {
    const managedMcpPath = join(root.path, 'managed-mcp.json');
    writeFileSync(join(root.path, file), '{}');
    const { directory } = setup([[proxy('a')]], false, { managedMcpPath });
    expect(directory.refusedPath(account)).toBeNull();
    await directory.list(account, env);
    expect(directory.refusedPath(account)).toBe(join(root.path, file));
  });
});

describe('the probe folder', () => {
  it('is made 0700 even when it already exists wider', async () => {
    const probeRoot = join(root.path, 'connector-probe');
    mkdirSync(probeRoot, { mode: 0o755 });
    chmodSync(probeRoot, 0o755);
    const { directory } = setup([[proxy('a')]]);
    await directory.list(account, env);
    expect(statSync(probeRoot).mode & 0o777).toBe(0o700);
  });

  it('is refused when it is a link, by the probe and by the sweep, and the target is left alone', async () => {
    const target = join(root.path, 'elsewhere');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'x');
    const probeRoot = join(root.path, 'connector-probe');
    symlinkSync(target, probeRoot);
    const { probes, directory } = setup([[proxy('a')]]);
    expect(await directory.list(account, env)).toBeNull();
    expect(probes).toHaveLength(0);
    await expect(sweepConnectorProbeRoot(probeRoot)).rejects.toBeInstanceOf(
      ConnectorProbeRefusedError,
    );
    expect(readdirSync(target)).toEqual(['keep.txt']);
  });
});
