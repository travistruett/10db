import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FoundHostDto, ProjectDto, WebHostDto, WebSearchDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('web access');
  repo = createTempRepo();
  daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

function writeInRepo(name: string, text: string): void {
  const path = join(repo.path, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const createProject = (): Promise<ProjectDto> =>
  api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });

const hosts = (id: string) => api().get(`/projects/${id}/web-hosts`, z.array(WebHostDto));
const names = async (id: string): Promise<string[]> => (await hosts(id)).map((h) => h.host);

describe('a project added with dependencies', () => {
  it('starts its read list with github.com and their documentation hosts', async () => {
    writeInRepo('package.json', JSON.stringify({ dependencies: { '@mantine/core': '8.0.0' } }));
    const project = await createProject();
    expect((await hosts(project.id)).map((h) => [h.host, h.source])).toEqual([
      ['github.com', { kind: 'start' }],
      ['www.npmjs.com', { kind: 'file', file: 'package.json' }],
      ['developer.mozilla.org', { kind: 'file', file: 'package.json' }],
      ['mantine.dev', { kind: 'file', file: 'package.json' }],
    ]);
  });
});

describe('after the project is added', () => {
  it('a dependency a lane adds reaches the list only when the builder adds it by name', async () => {
    const project = await createProject();
    expect(await names(project.id)).toEqual(['github.com']);

    writeInRepo('package.json', JSON.stringify({ dependencies: { react: '19.0.0' } }));
    const found = await api().post(`/projects/${project.id}/web-hosts/scan`, z.array(FoundHostDto));
    expect(found).toContainEqual({ host: 'react.dev', file: 'package.json' });
    expect(await names(project.id)).toEqual(['github.com']);

    const added = await send('POST', `/projects/${project.id}/web-hosts`, { host: 'react.dev' });
    expect(added.status).toBe(201);
    expect(WebHostDto.parse(added.body).source).toEqual({ kind: 'builder' });
    expect(await names(project.id)).toEqual(['github.com', 'react.dev']);
  });

  it('refuses a host the list may not hold, in words', async () => {
    const project = await createProject();
    const refused = await send('POST', `/projects/${project.id}/web-hosts`, {
      host: '*.github.com',
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('pattern');
  });

  it('removes a host, and answers 404 for one not listed', async () => {
    const project = await createProject();
    const remove = () => send('DELETE', `/projects/${project.id}/web-hosts/github.com`);
    expect((await remove()).status).toBe(200);
    expect(await names(project.id)).toEqual([]);
    expect((await remove()).status).toBe(404);
  });

  it('serves and sets the web search switch', async () => {
    const project = await createProject();
    const path = `/projects/${project.id}/web-search`;
    expect(await api().get(path, WebSearchDto)).toEqual({ enabled: true });
    expect((await send('PUT', path, { enabled: false })).status).toBe(200);
    expect(await api().get(path, WebSearchDto)).toEqual({ enabled: false });
    expect((await send('PUT', path, { enabled: 'no' })).status).toBe(400);
  });
});
