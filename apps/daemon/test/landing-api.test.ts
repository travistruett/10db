import { execFileSync } from 'node:child_process';
import { ProjectDto, TaskDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient, quickFlowId } from './api-client';
import { FakeGh } from './fake-gh';
import {
  createTempRepoWithOrigin,
  githubOrigin,
  isolatedGitEnv,
  NETWORK_ENV,
  tempDir,
} from './fixtures';

let data: { path: string; cleanup(): void };
let remote: ReturnType<typeof createTempRepoWithOrigin>;
let network: ReturnType<typeof githubOrigin>;
let daemon: RunningDaemon | null = null;
beforeEach(() => {
  data = tempDir('landing-daemon');
  remote = createTempRepoWithOrigin();
  network = githubOrigin(remote.repo.path, remote.origin.path);
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  remote.cleanup();
  network.cleanup();
  data.cleanup();
});

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv() })
    .toString()
    .trim();

async function start(projectLanding?: 'merge' | 'hold') {
  daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    gh: new FakeGh(),
    networkEnv: () => ({ ...NETWORK_ENV, GIT_CONFIG_GLOBAL: network.global }),
  });
  const api = apiClient(daemon.url, daemon.token);
  const project = await api.post('/projects', ProjectDto, {
    name: 'shop',
    repoPath: remote.repo.path,
    gateCommand: 'true',
    flowId: await quickFlowId(api),
    areas: [{ name: 'api', globs: ['src/api/**'] }],
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
    ...(projectLanding ? { landing: projectLanding } : {}),
  });
  return { api, project };
}

const TASK = { title: 'Alpha', acceptanceCriteria: ['it exists'], areas: ['api'] };

/** The error the API answered a request with: its status and message. */
async function refusal(
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<{ status: number; message: string }> {
  const res = await fetch(`${daemon?.url ?? ''}${path}`, {
    method,
    headers: { Authorization: `Bearer ${daemon?.token ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed: unknown = JSON.parse(await res.text());
  const message =
    typeof parsed === 'object' && parsed !== null && 'message' in parsed
      ? String(parsed.message)
      : '';
  return { status: res.status, message };
}

describe('where a task lands, through the API', () => {
  it('starts a task from the project default, and the default can change', async () => {
    const { api, project } = await start();
    expect(project.landing).toBe('merge');
    const merging = await api.post(`/projects/${project.id}/tasks`, TaskDto, TASK);
    expect(merging.landing).toEqual({ kind: 'base' });
    const held = await api.patch(`/projects/${project.id}`, ProjectDto, { landing: 'hold' });
    expect(held.landing).toBe('hold');
    const next = await api.post(`/projects/${project.id}/tasks`, TaskDto, TASK);
    expect(next.landing).toEqual({ kind: 'hold' });
  });

  it('keeps a branch origin has', async () => {
    const { api, project } = await start();
    git(remote.origin.path, 'branch', 'feature/x', 'main');
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      ...TASK,
      landing: { kind: 'branch', branch: 'feature/x' },
    });
    expect(task.landing).toEqual({ kind: 'branch', branch: 'feature/x' });
  });

  it('refuses a branch origin does not have, in plain words, when a task is made or changed', async () => {
    const { api, project } = await start();
    const made = await refusal(`/projects/${project.id}/tasks`, 'POST', {
      ...TASK,
      landing: { kind: 'branch', branch: 'feature/nope' },
    });
    expect(made.status).toBe(400);
    expect(made.message).toBe(
      'origin has no branch named feature/nope. Create it on origin, or choose another place for this task to land.',
    );
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, TASK);
    const changed = await refusal(`/tasks/${task.id}`, 'PATCH', {
      landing: { kind: 'branch', branch: 'feature/nope' },
    });
    expect(changed).toMatchObject({ status: 400, message: made.message });
    expect(
      (await api.patch(`/tasks/${task.id}`, TaskDto, { landing: { kind: 'hold' } })).landing,
    ).toEqual({
      kind: 'hold',
    });
  });

  it('does not ask origin about the project base branch', async () => {
    const { api, project } = await start();
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      ...TASK,
      landing: { kind: 'branch', branch: 'main' },
    });
    expect(task.landing).toEqual({ kind: 'branch', branch: 'main' });
  });
});
