import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  EvalLiveRunDto,
  EvalLivePreviewDto,
  EvalLiveRunState,
  EvalManifest,
  EvalSuiteKey,
  EvalSweepDto,
  EvalSweepId,
  mintId,
  ProjectDto,
} from '@10db/contracts';
import { createStore, insertEvalLiveRun, insertEvalSweep, openDatabase } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../daemon';
import { createEventBus, createStateStore } from '../events';
import { FakeAdapter } from '../sessions';
import { apiClient } from '../../test/api-client';
import { startDaemonWithProfiles } from '../../test/daemon-with-profiles';
import {
  createTempRepo,
  FAKE_SRT,
  homeOutsideTemp,
  isolatedGitEnv,
  type TempDir,
} from '../../test/fixtures';
import { previewHash } from './live-runs';

let base: string;
let homeDir: TempDir;
let repo: TempDir;
let daemon: RunningDaemon;

/** Starts a daemon on the test's data directory; a second start finds what the first left. */
const startIt = (catalogueSnapshot?: string): Promise<RunningDaemon> =>
  startDaemonWithProfiles({
    ...(catalogueSnapshot === undefined ? {} : { catalogueSnapshot }),
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

    // A changed model env since the window: refused the same way, then back to what it showed.
    const withModels = manifest();
    const [slow] = withModels.suites;
    if (slow?.live) slow.live.models = { env: 'MODELS', ids: 'openrouter' };
    expect((await send('PUT', `${at}/manifest`, withModels)).status).toBe(200);
    const modelsChanged = await send('POST', `${at}/slow/live/runs`, {
      previewHash: shown.previewHash,
    });
    expect(modelsChanged.status).toBe(409);
    expect(await modelsChanged.json()).toMatchObject({ refusal: 'manifest_changed' });
    expect((await send('PUT', `${at}/manifest`, manifest())).status).toBe(200);

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
        previewHash: previewHash(stored, project, []),
        docker: false,
        hostsJson: '[]',
        envFilesJson: '[]',
        costShownUsd: null,
        logPath: join(base, 'none.log'),
        modelsJson: null,
        sweepId: null,
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

describe('a model sweep, through the daemon', () => {
  const at = (projectId: string) => `/projects/${projectId}/evals`;
  const sweepSuite = (timeoutMinutes = 5) => ({
    key: 'sweep',
    definitionPaths: [],
    coveredPaths: [],
    liveCommand: `sh ${join(base, 'run.sh')}`,
    live: {
      docker: false,
      hosts: [],
      envFiles: [],
      loopback: false,
      timeoutMinutes,
      models: { env: 'MODELS', ids: 'openrouter' },
    },
  });
  const report = (slug: string, passed: boolean, cost: number) =>
    JSON.stringify({ passed, slots: [{ slug, passed, gates: {}, cost: { total: String(cost) } }] });

  /**
   * A project whose suite command writes the report a model earns: `acme/cheap` fails at 0.2, `acme/mid` passes
   * at 0.4, any other passes at 1; a committed older report of `acme/dear` (1.0) is the estimates' reference.
   * The command waits for the `release` file when a test asks it to.
   */
  async function sweepProject(wait: boolean) {
    const reports = join(repo.path, 'evals', 'reports', 'sweep');
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, '20200101T0000000Z.json'), report('acme/dear', true, 1));
    const env = isolatedGitEnv();
    execFileSync('git', ['-C', repo.path, 'add', 'evals/reports/sweep/20200101T0000000Z.json'], {
      env,
    });
    execFileSync('git', ['-C', repo.path, 'commit', '-q', '-m', 'seed report'], { env });
    writeFileSync(
      join(base, 'run.sh'),
      [
        wait ? `while [ ! -e ${join(base, 'release')} ]; do sleep 0.1; done` : '',
        'case "$MODELS" in',
        `  acme/cheap) p=false; c=0.2;;`,
        `  acme/mid) p=true; c=0.4;;`,
        `  *) p=true; c=1;;`,
        'esac',
        `printf '{"passed":%s,"slots":[{"slug":"%s","passed":%s,"gates":{},"cost":{"total":"%s"}}]}' "$p" "$MODELS" "$p" "$c" > ${reports}/$(date -u +%Y%m%dT%H%M%S)$$Z.json`,
      ].join('\n'),
    );
    const price = (output: number, name: string) => ({
      id: name,
      name,
      cost: { input: 1, output },
    });
    // The catalogue the tests share, with the OpenRouter entries the sweep's models are priced from.
    const catalogue = z
      .looseObject({ openrouter: z.looseObject({ models: z.record(z.string(), z.unknown()) }) })
      .parse(
        JSON.parse(
          readFileSync(join(import.meta.dirname, '../../test/fixtures/catalogue.json'), 'utf8'),
        ),
      );
    writeFileSync(
      join(base, 'catalogue.json'),
      JSON.stringify({
        ...catalogue,
        openrouter: {
          models: {
            'acme/cheap': price(1, 'acme/cheap'),
            'acme/mid': price(2, 'acme/mid'),
            'acme/dear': price(4, 'acme/dear'),
          },
        },
      }),
    );
    await daemon.stop();
    daemon = await startIt(join(base, 'catalogue.json'));
    const project = await apiClient(daemon.url, daemon.token).post('/projects', ProjectDto, {
      name: 'p',
      repoPath: repo.path,
      gateCommand: 'true',
      defaultRigor: 'light',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    const manifestWith = (suite: ReturnType<typeof sweepSuite>) => ({
      suites: [suite],
      gaps: [],
      callPatterns: [],
    });
    expect(
      (await send('PUT', `${at(project.id)}/manifest`, manifestWith(sweepSuite()))).status,
    ).toBe(200);
    return { project, manifestWith };
  }

  const latest = async (projectId: string) =>
    z
      .nullable(EvalSweepDto)
      .parse(await (await send('GET', `${at(projectId)}/sweep/sweeps/latest`)).json());
  const shownFor = async (projectId: string, models: string[]) =>
    EvalLivePreviewDto.parse(
      await (await send('GET', `${at(projectId)}/sweep/live?models=${models.join(',')}`)).json(),
    );

  it('a cheapest sweep stops at the first pass, and a later step is skipped, unpaid', async () => {
    const { project } = await sweepProject(false);
    // The request lists the dearest first; the server runs cheapest first by its own estimates.
    const models = ['acme/dear', 'acme/mid', 'acme/cheap'];
    const shown = await shownFor(project.id, models);
    const started = await send('POST', `${at(project.id)}/sweep/sweeps`, {
      kind: 'cheapest',
      models,
      capUsd: 5,
      previewHash: shown.previewHash,
    });
    expect(started.status).toBe(201);
    await vi.waitFor(
      async () => {
        expect((await latest(project.id))?.state).not.toBe('running');
      },
      { timeout: 30_000 },
    );
    const sweep = await latest(project.id);
    expect(sweep).toMatchObject({ state: 'found', winner: 'acme/mid' });
    expect(sweep?.steps.map((s) => [s.model, s.state])).toEqual([
      ['acme/cheap', 'failed'],
      ['acme/mid', 'passed'],
      ['acme/dear', 'skipped'],
    ]);
    expect(sweep?.spentUsd).toBeCloseTo(0.6);
  });

  it('a suite that changes between steps ends the sweep refused and starts no further step', async () => {
    const { project, manifestWith } = await sweepProject(true);
    const models = ['acme/cheap', 'acme/mid'];
    const shown = await shownFor(project.id, models);
    expect(
      (
        await send('POST', `${at(project.id)}/sweep/sweeps`, {
          kind: 'try',
          models,
          capUsd: 5,
          previewHash: shown.previewHash,
        })
      ).status,
    ).toBe(201);
    // The first step is running (held at the release file); the suite changes, then it is let go.
    expect(
      (await send('PUT', `${at(project.id)}/manifest`, manifestWith(sweepSuite(6)))).status,
    ).toBe(200);
    writeFileSync(join(base, 'release'), '');
    await vi.waitFor(
      async () => {
        expect((await latest(project.id))?.state).not.toBe('running');
      },
      { timeout: 30_000 },
    );
    const sweep = await latest(project.id);
    expect(sweep).toMatchObject({ state: 'stopped', reason: 'refused' });
    expect(sweep?.steps.map((s) => s.state)).toEqual(['failed', 'skipped']);
    const runs = z
      .array(EvalLiveRunDto)
      .parse(await (await send('GET', `${at(project.id)}/live/runs?suite=sweep`)).json());
    expect(runs).toHaveLength(1);
  });

  it('a restart ends a running sweep interrupted and starts nothing', async () => {
    const project = await apiClient(daemon.url, daemon.token).post('/projects', ProjectDto, {
      name: 'p',
      repoPath: repo.path,
      gateCommand: 'true',
      defaultRigor: 'light',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    const ran = join(base, 'command-ran');
    const sweepId = mintId('EvalSweep');
    const step = (model: string, state: string) =>
      ({ model, state, estimateUsd: null, costUsd: null, runId: null }) as const;
    // What a crash leaves: a running sweep and the run of its first step, with no process behind either.
    // They are written while the daemon is down, since a daemon that stops ends the sweeps it knows.
    await daemon.stop();
    const db = openDatabase(join(base, 'data', '10db.sqlite'));
    createStateStore(createStore(db), createEventBus()).write((ctx) => {
      insertEvalSweep(ctx, {
        id: sweepId,
        projectId: project.id,
        suiteKey: EvalSuiteKey.parse('sweep'),
        kind: 'try',
        capUsd: 5,
        modelsJson: JSON.stringify(['acme/cheap', 'acme/mid']),
        previewHash: 'shown',
        stepsJson: JSON.stringify([step('acme/cheap', 'running'), step('acme/mid', 'waiting')]),
      });
      insertEvalLiveRun(ctx, {
        id: mintId('EvalLiveRun'),
        projectId: project.id,
        suiteKey: EvalSuiteKey.parse('sweep'),
        command: `touch ${ran}`,
        stopCommand: null,
        previewHash: 'shown',
        docker: false,
        hostsJson: '[]',
        envFilesJson: '[]',
        costShownUsd: null,
        logPath: join(base, 'none.log'),
        modelsJson: JSON.stringify(['acme/cheap']),
        sweepId,
      });
    });
    db.$client.close();
    daemon = await startIt();
    const sweep = EvalSweepDto.parse(
      await (await send('GET', `${at(project.id)}/sweeps/${EvalSweepId.parse(sweepId)}`)).json(),
    );
    expect(sweep).toMatchObject({ state: 'stopped', reason: 'interrupted' });
    expect(sweep.steps.map((s) => s.state)).toEqual(['stopped', 'skipped']);
    const runs = z
      .array(EvalLiveRunDto)
      .parse(await (await send('GET', `${at(project.id)}/live/runs?suite=sweep`)).json());
    expect(runs.map((r) => r.state)).toEqual([EvalLiveRunState.Interrupted]);
    expect(existsSync(ran)).toBe(false);
  });
});
