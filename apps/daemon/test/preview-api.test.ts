import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassOpenedDto, ProjectDto, TaskDto, mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { FakeCamera } from './fake-camera';
import { createTempRepo, tempDir, waitFor, waitForAsync, type TempDir } from './fixtures';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open, through the wiring: a daemon runs a
// project's preview command once a pass opens, Restart Preview over HTTP runs it again, and the
// daemon's stop ends it. No sandbox here, as for the other API tests whose commands need none.

let data: TempDir;
let repo: TempDir;
let daemon: RunningDaemon | null;

beforeEach(async () => {
  data = tempDir('preview api');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    pictures: { kind: 'given', camera: new FakeCamera(), prepare: () => undefined },
  });
});

afterEach(async () => {
  await daemon?.stop();
  repo.cleanup();
  data.cleanup();
});

function running(): RunningDaemon {
  if (daemon === null) throw new Error('the daemon has stopped');
  return daemon;
}
const api = () => apiClient(running().url, running().token);
const post = (path: string) =>
  fetch(`${running().url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${running().token}` },
  });

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) =>
    probe.close(() => {
      resolve();
    }),
  );
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

const answers = async (url: string): Promise<boolean> =>
  fetch(url).then(
    () => true,
    () => false,
  );

describe('the preview over HTTP', () => {
  it('runs once a pass opens, runs again on Restart Preview, and ends with the daemon', async () => {
    const port = await freePort();
    const app = `http://127.0.0.1:${String(port)}`;
    const marks = join(data.path, 'starts');
    const starts = () =>
      existsSync(marks) ? readFileSync(marks, 'utf8').split('\n').filter(Boolean).length : 0;
    const made = await api().post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'true',
      sandboxLoopback: true,
      areas: [{ name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' }],
    });
    await api().patch(`/projects/${made.id}`, ProjectDto, {
      appUrl: app,
      previewCommand: `echo start >> '${marks}'; exec '${process.execPath}' -e "require('http').createServer((q, s) => s.end('ok')).listen(${String(port)}, '127.0.0.1')"`,
    });
    expect(await answers(app)).toBe(false);
    const task = await api().post(`/projects/${made.id}/tasks`, TaskDto, {
      title: 'People: UI work',
      acceptanceCriteria: ['x'],
      areas: ['people'],
    });
    await api().post(`/projects/${made.id}/passes`, PassOpenedDto, {
      name: 'Polish',
      taskIds: [task.id],
    });
    await waitForAsync(() => answers(app));
    expect(starts()).toBe(1);

    expect((await post(`/projects/${made.id}/preview/restart`)).status).toBe(204);
    await waitFor(() => starts() === 2);
    await waitForAsync(() => answers(app));
    expect((await post(`/projects/${mintId('Project')}/preview/restart`)).status).toBe(404);

    await running().stop();
    daemon = null;
    expect(await answers(app)).toBe(false);
  });
});
