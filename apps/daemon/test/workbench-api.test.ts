import { execFileSync } from 'node:child_process';
import {
  PassAbandonedDto,
  PassOpenedDto,
  PassStartDto,
  PassViewDto,
  ProjectDto,
  TaskDto,
  type ProjectInput,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { createTempRepo, isolatedGitEnv, tempDir } from './fixtures';

// Workbench spec §4.2, §4.3, §5: the routes the Workbench reads and acts through, over HTTP on a real
// repository and database. No page here is sent a message, so no session starts.

const PAGES: ProjectInput['areas'] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  { name: 'src', globs: ['src/**'], role: 'shared' },
];

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('workbench api');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    // A tick long enough that nothing starts while the test looks.
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);
const rawGit = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], {
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();

/** A request with a JSON body, answered with its status and parsed body whatever the status. */
async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: jsonOrText(await res.text()) };
}

/** A response body as JSON, or its text when it is not JSON (hono's own 404). */
function jsonOrText(text: string): unknown {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    return text;
  }
}

async function projectWith(areas: ProjectInput['areas'], name = 'demo', repoPath = repo.path) {
  return api().post('/projects', ProjectDto, { name, repoPath, gateCommand: null, areas });
}

async function taskOn(project: ProjectDto, title: string, areas: string[]) {
  return api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title,
    acceptanceCriteria: ['x'],
    areas,
    dependsOn: [],
  });
}

async function openOn(project: ProjectDto, tasks: readonly TaskDto[]) {
  return api().post(`/projects/${project.id}/passes`, PassOpenedDto, {
    name: 'Polish',
    taskIds: tasks.map((t) => t.id),
  });
}

describe('GET /passes?live=true', () => {
  it('answers each live pass as the Workbench reads it, and none once it is abandoned', async () => {
    const project = await projectWith(PAGES);
    const settings = await taskOn(project, 'Settings: tidy', ['settings']);
    const opened = await openOn(project, [settings]);

    const live = await api().get('/passes?live=true', z.array(PassViewDto));
    expect(live.map((v) => [v.pass.id, v.pages.map((p) => p.taskId)])).toEqual([
      [opened.pass.id, [settings.id]],
    ]);

    await api().post(`/passes/${opened.pass.id}/abandon`, PassAbandonedDto);
    expect(await api().get('/passes?live=true', z.array(PassViewDto))).toEqual([]);
    expect(rawGit('symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('refuses a list of passes that is not the live one', async () => {
    expect((await send('GET', '/passes')).status).toBe(400);
  });
});

describe('GET /projects/:projectId/pass-start', () => {
  it('says what Start Pass shows: the pages, and that the gate needs Docker, which is off', async () => {
    const project = await api().post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'docker compose run --rm test',
      areas: PAGES,
    });

    const start = await api().get(`/projects/${project.id}/pass-start`, PassStartDto);

    expect(start.pages.map((p) => [p.area, p.route])).toEqual([
      ['settings', '/settings'],
      ['people', '/people'],
    ]);
    expect(start.lacks.map((l) => l.kind)).toContain('docker_off');
    expect(start.refusal).toBeNull();
  });
});
