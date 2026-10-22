import { execFileSync } from 'node:child_process';
import {
  BatchDto,
  ProjectDto,
  ProjectViewDto,
  SystemCheckDto,
  TaskDto,
  WorkstreamDto,
  type SystemCheckDto as SystemCheck,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import { apiClient, quickFlowId } from './api-client';
import { FakeGh } from './fake-gh';
import {
  createTempRepoWithOrigin,
  isolatedGitEnv,
  NETWORK_ENV,
  tempDir,
  waitForAsync,
} from './fixtures';

const write = (path: string) => ({
  do: 'tool' as const,
  toolName: 'Write',
  input: { file_path: path, content: `${path}\n` },
});
const commit = (opId: string, path: string) => ({
  do: 'mcp' as const,
  tool: 'commit',
  args: { opId, paths: [path], message: `Add ${path}` },
});
const BOOK: FakeScriptBook = {
  Alpha: [
    [
      write('src/api/alpha.txt'),
      commit('op-alpha-0001', 'src/api/alpha.txt'),
      { do: 'turn_complete' },
    ],
  ],
  Beta: [
    [write('src/ui/beta.txt'), commit('op-beta-00001', 'src/ui/beta.txt'), { do: 'turn_complete' }],
  ],
};

let data: { path: string; cleanup(): void };
let remote: ReturnType<typeof createTempRepoWithOrigin>;
let gh: FakeGh;
let daemon: RunningDaemon | null = null;
beforeEach(() => {
  data = tempDir('batch-daemon');
  remote = createTempRepoWithOrigin();
  gh = new FakeGh();
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  remote.cleanup();
  data.cleanup();
});

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv() })
    .toString()
    .trim();

async function start(systemCheck?: () => Promise<SystemCheck>) {
  daemon = await startDaemon({
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter(BOOK),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    gh,
    networkEnv: () => NETWORK_ENV,
    ...(systemCheck ? { systemCheck } : {}),
  });
  const api = apiClient(daemon.url, daemon.token);
  const project = await api.post('/projects', ProjectDto, {
    name: 'shop',
    repoPath: remote.repo.path,
    gateCommand: 'true',
    flowId: await quickFlowId(api),
    areas: [
      { name: 'api', globs: ['src/api/**'] },
      { name: 'ui', globs: ['src/ui/**'] },
    ],
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
  });
  const task = (title: string, area: string) =>
    api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title,
      acceptanceCriteria: ['it exists'],
      areas: [area],
    });
  return { api, project, alpha: await task('Alpha', 'api'), beta: await task('Beta', 'ui') };
}

describe('batch delivery through the daemon', () => {
  it('ships a two-task batch as one pull request', async () => {
    const { api, project, alpha, beta } = await start();
    const batch = await api.post(`/projects/${project.id}/batches`, BatchDto, {
      title: 'Greetings for everyone',
      taskIds: [alpha.id, beta.id],
    });
    expect(batch.state).toBe('CUTTING');
    const shipped = await waitForAsync(async () => {
      const view = (await api.get('/projects', z.array(ProjectViewDto))).find(
        (p) => p.id === project.id,
      );
      return view?.currentBatch?.state === 'SHIPPED' ? view.currentBatch : undefined;
    }, 30_000);
    expect(shipped).toMatchObject({
      id: batch.id,
      prUrl: 'https://github.com/acme/widgets/pull/1',
    });
    expect(gh.prCreates()).toEqual([
      {
        repo: 'acme/widgets',
        base: 'main',
        head: shipped.branch,
        title: 'feat(app): greetings for everyone',
      },
    ]);
    expect(git(remote.origin.path, 'rev-parse', `refs/heads/${shipped.branch ?? ''}`)).toBe(
      git(remote.repo.path, 'rev-parse', 'HEAD'),
    );
    expect(
      git(remote.repo.path, 'log', '--format=%s', `${shipped.baseSha ?? ''}..HEAD`)
        .split('\n')
        .sort(),
    ).toEqual(['Add src/api/alpha.txt', 'Add src/ui/beta.txt']);
    expect(gh.body(shipped.prUrl ?? '')).toContain(`Shipped by 10db, batch ${shipped.id}`);
    expect(git(remote.origin.path, 'rev-parse', 'main')).toBe(shipped.baseSha);
  });

  it('answers 202 with the batch when a task starts, and gives two racing starts one batch and one branch', async () => {
    const { api, project, alpha, beta } = await start();
    const call = (id: string) =>
      fetch(`${daemon?.url ?? ''}/tasks/${id}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${daemon?.token ?? ''}` },
      });
    const [a, b] = await Promise.all([call(alpha.id), call(beta.id)]);
    // The second start joins the batch (202) or meets it still CUTTING (409); it never makes a second one.
    expect([a.status, b.status]).toContain(202);
    for (const status of [a.status, b.status]) expect([202, 409]).toContain(status);
    await waitForAsync(async () => {
      const view = (await api.get('/projects', z.array(ProjectViewDto))).find(
        (p) => p.id === project.id,
      );
      return view?.currentBatch?.state === 'SHIPPED' || view?.currentBatch?.state === 'CLOSED'
        ? true
        : undefined;
    }, 30_000);
    expect(
      git(remote.repo.path, 'branch', '--list', '10db/*').split('\n').filter(Boolean),
    ).toHaveLength(1);
  });

  it('marks gh required in the system check once a project delivers pull requests', async () => {
    const check: SystemCheck = SystemCheckDto.parse({
      loginEnv: { source: 'login_shell', warning: null },
      tools: [{ name: 'gh', path: null, version: null, required: false }],
    });
    const { api } = await start(() => Promise.resolve(check));
    const system = await api.get('/system', SystemCheckDto);
    expect(system.tools.find((t) => t.name === 'gh')?.required).toBe(true);
  });

  it('still answers 201 with the workstream in a local project', async () => {
    daemon = await startDaemon({
      dataDir: data.path,
      port: 0,
      adapter: new FakeAdapter(BOOK),
      logLevel: 'warn',
      caffeinate: () => null,
      watch: false,
      gh,
    });
    const api = apiClient(daemon.url, daemon.token);
    const project = await api.post('/projects', ProjectDto, {
      name: 'local',
      repoPath: remote.repo.path,
      gateCommand: 'true',
      flowId: await quickFlowId(api),
      areas: [{ name: 'api', globs: ['src/api/**'] }],
    });
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Alpha',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    expect((await api.post(`/tasks/${task.id}/start`, WorkstreamDto)).taskId).toBe(task.id);
    expect(gh.calls).toEqual([]);
  });
});
