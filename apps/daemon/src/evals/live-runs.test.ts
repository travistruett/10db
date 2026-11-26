import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  EvalLiveRunDto,
  EvalLivePreviewDto,
  EvalLiveRunState,
  EvalSuiteKey,
  mintId,
  ProjectDto,
  type EvalManifest,
} from '@10db/contracts';
import { createTestStore, insertEvalLiveRun, listEvalLiveRuns, seedProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../daemon';
import { createEventBus, createStateStore } from '../events';
import { FakeAdapter } from '../sessions';
import { silentLogger } from '../log';
import { systemClock } from '../clock';
import { apiClient } from '../../test/api-client';
import { startDaemonWithProfiles } from '../../test/daemon-with-profiles';
import { createTempRepo, FAKE_SRT, homeOutsideTemp, type TempDir } from '../../test/fixtures';
import { createEvalLiveRuns } from './live-runs';

let base: string;
let homeDir: TempDir;
let repo: TempDir;
let daemon: RunningDaemon;

beforeEach(async () => {
  // A short base: a lane temp directory's whole path must fit the sandbox's limit.
  base = realpathSync(mkdtempSync('/tmp/sbl-'));
  homeDir = homeOutsideTemp('sbl');
  const home = join(homeDir.path, 'home');
  mkdirSync(home);
  repo = createTempRepo();
  const systemTempRoots = [join(base, 'sys')];
  mkdirSync(systemTempRoots[0] ?? '');
  daemon = await startDaemonWithProfiles({
    dataDir: join(base, 'data'),
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    sandbox: {
      tmpRoot: join(base, 't'),
      codexLaneTempRoot: join(base, 'l'),
      filesRoot: join(base, 'r'),
      systemTempRoots,
      runtime: FAKE_SRT,
    },
    builderHome: home,
    caffeinate: () => null,
    watch: false,
    tickMs: 3_600_000,
  });
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
    expect((await runs('slow')).map((r) => r.state)).toEqual([EvalLiveRunState.Stopped]);

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
  it('is interrupted at the next start, and nothing reruns', async () => {
    const { store, close } = createTestStore();
    try {
      const project = seedProject(store);
      const state = createStateStore(
        store,
        createEventBus(() => undefined),
      );
      const row = state.write((ctx) =>
        insertEvalLiveRun(ctx, {
          id: mintId('EvalLiveRun'),
          projectId: project.id,
          suiteKey: EvalSuiteKey.parse('slow'),
          command: 'sleep 60',
          stopCommand: null,
          previewHash: 'h',
          docker: false,
          hostsJson: '[]',
          envFilesJson: '[]',
          logPath: '/tmp/none.log',
        }),
      );
      expect(row?.state).toBe(EvalLiveRunState.Running);
      const runs = createEvalLiveRuns({
        gates: {
          run: () => {
            throw new Error('recovery never starts a command');
          },
        },
        ledgers: null,
        sandboxed: true,
        dataDir: '/tmp',
        clock: systemClock,
        state,
        evals: { suite: () => Promise.reject(new Error('unused')) },
        checkouts: () => [],
        env: () => ({}),
        logger: silentLogger,
      });
      await runs.recoverAtStart();
      expect(listEvalLiveRuns(store.db, project.id, null, 5).map((r) => r.state)).toEqual([
        EvalLiveRunState.Interrupted,
      ]);
    } finally {
      close();
    }
  });
});
