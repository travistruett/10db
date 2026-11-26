import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  EvalLiveRunDto,
  EvalLivePreviewDto,
  EvalLiveRunState,
  EvalManifest,
  EvalSuiteKey,
  mintId,
  ProjectDto,
} from '@10db/contracts';
import { insertEvalLiveRun } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../daemon';
import { FakeAdapter } from '../sessions';
import { apiClient } from '../../test/api-client';
import { startDaemonWithProfiles } from '../../test/daemon-with-profiles';
import { createTempRepo, FAKE_SRT, homeOutsideTemp, type TempDir } from '../../test/fixtures';
import { previewHash } from './live-runs';

let base: string;
let homeDir: TempDir;
let repo: TempDir;
let daemon: RunningDaemon;

/** Starts a daemon on the test's data directory; a second start finds what the first left. */
const startIt = (): Promise<RunningDaemon> =>
  startDaemonWithProfiles({
    dataDir: join(base, 'data'),
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    sandbox: {
      tmpRoot: join(base, 't'),
      codexLaneTempRoot: join(base, 'l'),
      filesRoot: join(base, 'r'),
      systemTempRoots: [join(base, 'sys')],
      runtime: FAKE_SRT,
    },
    builderHome: join(homeDir.path, 'home'),
    caffeinate: () => null,
    watch: false,
    tickMs: 3_600_000,
  });

beforeEach(async () => {
  // A short base: a lane temp directory's whole path must fit the sandbox's limit.
  base = realpathSync(mkdtempSync('/tmp/sbl-'));
  homeDir = homeOutsideTemp('sbl');
  mkdirSync(join(homeDir.path, 'home'));
  repo = createTempRepo();
  mkdirSync(join(base, 'sys'));
  daemon = await startIt();
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  rmSync(base, { recursive: true, force: true });
  homeDir.cleanup();
});

const manifest = (): EvalManifest => ({
  suites: [
    {
      key: 'slow',
      definitionPaths: [],
      coveredPaths: [],
      liveCommand: 'sleep 60',
      live: { docker: false, hosts: [], envFiles: [], loopback: false, timeoutMinutes: 5 },
    },
    {
      key: 'calls-docker',
      definitionPaths: [],
      coveredPaths: [],
      liveCommand: 'docker ps',
      live: { docker: false, hosts: [], envFiles: [], loopback: false, timeoutMinutes: 5 },
    },
  ],
  gaps: [],
  callPatterns: [],
});

async function send(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown) {
  return fetch(`${daemon.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('a suite’s live run, through the daemon', () => {
  it('runs only what the window showed, one at a time, and never turns Docker on', async () => {
    const project = await apiClient(daemon.url, daemon.token).post('/projects', ProjectDto, {
      name: 'p',
      repoPath: repo.path,
      gateCommand: 'true',
      defaultRigor: 'light',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    const at = `/projects/${project.id}/evals`;
    expect((await send('PUT', `${at}/manifest`, manifest())).status).toBe(200);
    const shown = EvalLivePreviewDto.parse(await (await send('GET', `${at}/slow/live`)).json());
    expect(shown.refusal).toBeNull();

    // A stale window: refused, no row, nothing run.
    const stale = await send('POST', `${at}/slow/live/runs`, { previewHash: 'stale' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ refusal: 'manifest_changed' });
    const runs = async (suite: string) =>
      z
        .array(EvalLiveRunDto)
        .parse(await (await send('GET', `${at}/live/runs?suite=${suite}`)).json());
    expect(await runs('slow')).toEqual([]);

    // The click starts it; a second click while it runs is refused busy.
    const started = await send('POST', `${at}/slow/live/runs`, { previewHash: shown.previewHash });
    expect(started.status).toBe(201);
    const run = EvalLiveRunDto.parse(await started.json());
    const second = await send('POST', `${at}/slow/live/runs`, { previewHash: shown.previewHash });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ refusal: 'busy' });
    expect((await send('POST', `${at}/live/runs/${run.id}/stop`)).status).toBe(204);
    // Stop answers once the abort is sent; the run settles after.
    await vi.waitFor(async () => {
      expect((await runs('slow')).map((r) => r.state)).toEqual([EvalLiveRunState.Stopped]);
    });

    // A command that calls docker runs without the project's Docker switch ever turning on.
    const docker = EvalLivePreviewDto.parse(
      await (await send('GET', `${at}/calls-docker/live`)).json(),
    );
    expect(
      (await send('POST', `${at}/calls-docker/live/runs`, { previewHash: docker.previewHash }))
        .status,
    ).toBe(201);
    await vi.waitFor(
      async () => {
        expect((await runs('calls-docker'))[0]?.state).not.toBe(EvalLiveRunState.Running);
      },
      { timeout: 20_000 },
    );
    const projects = z.array(ProjectDto).parse(await (await send('GET', '/projects')).json());
    expect(projects.find((p) => p.id === project.id)?.sandboxDocker).toBe(false);
  });
});

describe('a run a crash left', () => {
  it('is interrupted at the next start, its stop command runs and its command never does', async () => {
    const project = await apiClient(daemon.url, daemon.token).post('/projects', ProjectDto, {
      name: 'p',
      repoPath: repo.path,
      gateCommand: 'true',
      defaultRigor: 'light',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    const ran = join(base, 'command-ran');
    const stopped = join(base, 'stop-ran');
    const suite = {
      key: 'left',
      definitionPaths: [],
      coveredPaths: [],
      liveCommand: `touch ${ran}`,
      live: {
        docker: false,
        hosts: [],
        envFiles: [],
        loopback: false,
        stopCommand: `touch ${stopped}`,
        timeoutMinutes: 5,
      },
    };
    const at = `/projects/${project.id}/evals`;
    expect(
      (await send('PUT', `${at}/manifest`, { suites: [suite], gaps: [], callPatterns: [] })).status,
    ).toBe(200);
    // What a crash leaves: a running row, as the confirm window showed it, with no process behind it.
    const stored = EvalManifest.parse({ suites: [suite], gaps: [], callPatterns: [] }).suites[0];
    if (stored === undefined) throw new Error('no suite');
    daemon.state.write((ctx) =>
      insertEvalLiveRun(ctx, {
        id: mintId('EvalLiveRun'),
        projectId: project.id,
        suiteKey: EvalSuiteKey.parse('left'),
        command: `touch ${ran}`,
        stopCommand: `touch ${stopped}`,
        previewHash: previewHash(stored, project),
        docker: false,
        hostsJson: '[]',
        envFilesJson: '[]',
        costShownUsd: null,
        logPath: join(base, 'none.log'),
      }),
    );
    await daemon.stop();
    daemon = await startIt();
    const listed = async () =>
      z.array(EvalLiveRunDto).parse(await (await send('GET', `${at}/live/runs?suite=left`)).json());
    // The stop command runs after start, in the background; the row says so once it has.
    await vi.waitFor(
      async () => {
        expect((await listed())[0]?.stopRan).toBe(true);
      },
      { timeout: 20_000 },
    );
    expect((await listed()).map((r) => r.state)).toEqual([EvalLiveRunState.Interrupted]);
    expect(existsSync(stopped)).toBe(true);
    expect(existsSync(ran)).toBe(false);
  });
});
