import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { buildClaudeTarball, pinForTarball, servingTarball } from '../../test/pinned-tarball';
import { AgentTool, type AgentPin } from './agent-pins';
import { pinnedToolsRoot, removePinned } from './pinned-install';
import {
  isNewerRelease,
  startPinnedTools,
  type FetchLatest,
  type PinnedProbe,
  type PinnedToolsOptions,
  type RunningAgentTools,
} from './pinned-tools';

let dir: { path: string; cleanup(): void };
let running: RunningAgentTools | null = null;
beforeEach(() => {
  dir = tempDir('pinned-tools');
});
afterEach(async () => {
  running?.stop();
  running = null;
  await removePinned(pinnedToolsRoot(join(dir.path, 'data')));
  dir.cleanup();
});

/** Both tools pinned to the same fake tarball, as two copies of different tools. */
async function pins(tarball: string, version = '1.2.3') {
  const claude = await pinForTarball(tarball, version);
  const codex: AgentPin = { ...claude, tool: AgentTool.Codex, label: 'Codex' };
  return { [AgentTool.Claude]: claude, [AgentTool.Codex]: codex };
}

const runs =
  (output: string): PinnedProbe =>
  () =>
    Promise.resolve(output);

function start(options: Partial<PinnedToolsOptions>) {
  running = startPinnedTools({
    dataDir: join(dir.path, 'data'),
    probe: runs('1.2.3 (tool)'),
    fetchLatest: () => Promise.resolve('1.2.3'),
    ...options,
  });
  return running;
}

describe('the pinned agent tools', () => {
  it('fetch both copies and report each ready on its path and the version it prints', async () => {
    const tarball = buildClaudeTarball(dir.path, 'ok', '1.2.3');
    const tools = start({ pins: await pins(tarball), install: servingTarball(tarball) });
    expect(tools.statuses().map((s) => s.state)).toEqual(['fetching', 'fetching']);
    await tools.settled();
    expect(tools.statuses()).toEqual([
      expect.objectContaining({
        tool: 'claude',
        pinned: '1.2.3',
        state: 'ready',
        version: '1.2.3 (tool)',
        problem: null,
        newerRelease: null,
      }),
      expect.objectContaining({ tool: 'codex', state: 'ready' }),
    ]);
    expect(tools.statuses()[0]?.path).toBe(
      join(dir.path, 'data', 'tools', 'claude-1.2.3-darwin-arm64', 'claude'),
    );
  });

  it('refuse a download that is not the recorded one and name the tool and why', async () => {
    const real = buildClaudeTarball(dir.path, 'real', '1.2.3');
    const swapped = buildClaudeTarball(dir.path, 'swapped', 'evil');
    const tools = start({ pins: await pins(real), install: servingTarball(swapped) });
    await tools.settled();
    const [claude] = tools.statuses();
    expect(claude).toMatchObject({ state: 'refused', path: null, version: null });
    expect(claude?.problem).toMatch(/^Claude Code 1\.2\.3 was refused: .*not the recorded sha512-/);
  });

  it('refuse a copy that prints another version than the pin', async () => {
    const tarball = buildClaudeTarball(dir.path, 'other', '9.9.9');
    const tools = start({
      pins: await pins(tarball),
      install: servingTarball(tarball),
      probe: runs('9.9.9 (Claude Code)'),
    });
    await tools.settled();
    expect(tools.statuses()[0]?.problem).toContain(
      'reports "9.9.9 (Claude Code)", which is not 1.2.3',
    );
  });

  it('refuse a copy that does not run', async () => {
    const tarball = buildClaudeTarball(dir.path, 'dead', '1.2.3');
    const tools = start({
      pins: await pins(tarball),
      install: servingTarball(tarball),
      probe: () => Promise.resolve(null),
    });
    await tools.settled();
    expect(tools.statuses()[0]?.problem).toContain('--version failed');
  });

  it('try the fetch again on a retry, and stay ready once they are', async () => {
    const tarball = buildClaudeTarball(dir.path, 'retry', '1.2.3');
    const net = servingTarball(tarball);
    let offline = true;
    const tools = start({
      pins: await pins(tarball),
      install: {
        ...net,
        download: (url, to) =>
          offline ? Promise.reject(new Error('offline')) : net.download(url, to),
      },
    });
    await tools.settled();
    expect(tools.statuses()[0]?.state).toBe('refused');
    expect(tools.statuses()[0]?.problem).toContain('offline');
    offline = false;
    await tools.retry();
    await tools.settled();
    expect(tools.statuses().map((s) => s.state)).toEqual(['ready', 'ready']);
    const calls = net.calls();
    await tools.retry();
    await tools.settled();
    expect(net.calls()).toBe(calls);
  });

  it('answer a retry during a download at once, and leave that download the only one', async () => {
    const tarball = buildClaudeTarball(dir.path, 'inflight', '1.2.3');
    const net = servingTarball(tarball);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tools = start({
      pins: await pins(tarball),
      install: { ...net, download: async (url, to) => gate.then(() => net.download(url, to)) },
    });
    // The download has not finished, yet the retry answers.
    await tools.retry();
    expect(tools.statuses().map((s) => s.state)).toEqual(['fetching', 'fetching']);
    release();
    await tools.settled();
    expect(tools.statuses().map((s) => s.state)).toEqual(['ready', 'ready']);
    expect(net.calls()).toBe(2);
  });

  it('fetch a fresh copy on a retry in place of one that was refused', async () => {
    const tarball = buildClaudeTarball(dir.path, 'refetch', '1.2.3');
    const net = servingTarball(tarball);
    const tools = start({ pins: await pins(tarball), install: net });
    await tools.settled();
    const exe = tools.statuses()[0]?.path ?? '';
    const copy = join(dir.path, 'data', 'tools', 'claude-1.2.3-darwin-arm64');
    chmodSync(copy, 0o755);
    chmodSync(exe, 0o755);
    writeFileSync(exe, '#!/bin/sh\necho owned\n');
    running?.stop();
    const again = start({ pins: await pins(tarball), install: net });
    await again.settled();
    expect(again.statuses()[0]?.state).toBe('refused');
    expect(again.statuses()[0]?.problem).toContain('no longer match');
    await again.retry();
    await again.settled();
    expect(again.statuses()[0]?.state).toBe('ready');
    expect(readFileSync(exe, 'utf8')).toContain('1.2.3');
  });

  it('name the tool when its check fails in a way nobody foresaw', async () => {
    const tarball = buildClaudeTarball(dir.path, 'odd', '1.2.3');
    const tools = start({
      pins: await pins(tarball),
      install: servingTarball(tarball),
      probe: () => Promise.reject(new Error('EMFILE: too many open files')),
    });
    await tools.settled();
    expect(tools.statuses()[0]?.problem).toBe(
      'Claude Code 1.2.3 was refused: EMFILE: too many open files',
    );
  });

  it('let an older release of a tool go once its pinned copy is ready', async () => {
    const old = buildClaudeTarball(dir.path, 'old', '1.2.2');
    const first = start({ pins: await pins(old, '1.2.2'), install: servingTarball(old) });
    await first.settled();
    first.stop();
    const tarball = buildClaudeTarball(dir.path, 'new', '1.2.3');
    const tools = start({ pins: await pins(tarball), install: servingTarball(tarball) });
    await tools.settled();
    expect(readdirSync(join(dir.path, 'data', 'tools')).sort()).toEqual([
      'claude-1.2.3-darwin-arm64',
      'codex-1.2.3-darwin-arm64',
    ]);
  });

  it('run a path given in place of the pinned copy, with nothing fetched', async () => {
    const tarball = buildClaudeTarball(dir.path, 'unused', '1.2.3');
    const net = servingTarball(tarball);
    const tools = start({
      pins: await pins(tarball),
      install: net,
      overrides: { claude: '/custom/claude' },
      probe: runs('7.7.7 (custom)'),
    });
    await tools.settled();
    expect(tools.statuses()[0]).toMatchObject({
      state: 'ready',
      path: '/custom/claude',
      version: '7.7.7 (custom)',
    });
    expect(net.calls()).toBe(1);
  });

  it('name a newer upstream release, and clear it once the pin has caught up', async () => {
    const tarball = buildClaudeTarball(dir.path, 'newer', '1.2.3');
    let latest = '1.3.0';
    const fetchLatest: FetchLatest = () => Promise.resolve(latest);
    const tools = start({
      pins: await pins(tarball),
      install: servingTarball(tarball),
      fetchLatest,
    });
    await tools.settled();
    expect(tools.statuses().map((s) => s.newerRelease)).toEqual(['1.3.0', '1.3.0']);
    latest = '1.2.3';
    await tools.retry();
    expect(tools.statuses().map((s) => s.newerRelease)).toEqual([null, null]);
  });

  it('keep the last answer when upstream cannot be reached', async () => {
    const tarball = buildClaudeTarball(dir.path, 'flaky', '1.2.3');
    let reachable = true;
    const fetchLatest: FetchLatest = () =>
      reachable ? Promise.resolve('1.4.0') : Promise.reject(new Error('offline'));
    const tools = start({
      pins: await pins(tarball),
      install: servingTarball(tarball),
      fetchLatest,
    });
    await tools.settled();
    reachable = false;
    await tools.retry();
    expect(tools.statuses()[0]?.newerRelease).toBe('1.4.0');
  });
});

describe('isNewerRelease', () => {
  it.each([
    ['a later minor', '0.168.0', '0.167.0', true],
    ['a later patch', '2.1.303', '2.1.302', true],
    ['a later major', '3.0.0', '2.9.9', true],
    ['the same release', '0.167.0', '0.167.0', false],
    ['an earlier release', '0.166.9', '0.167.0', false],
    ['a numeric, not textual, comparison', '0.10.0', '0.9.0', true],
    ['a pre-release', '0.168.0-alpha.1', '0.167.0', false],
    ['something unreadable', 'latest', '0.167.0', false],
  ])('%s', (_name, candidate, base, expected) => {
    expect(isNewerRelease(candidate, base)).toBe(expected);
  });
});
