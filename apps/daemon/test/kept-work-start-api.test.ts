import { Delivery, ProjectDto, TaskDto, TaskId } from '@10db/contracts';
import { getTaskKeptWork, listWorkstreams, setTaskKeptWork } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

// Workbench spec §5.4: a task taken out of a pass keeps its work saved until a later pass puts it
// back. Until an ordinary start can put it back too, starting it from the Board is refused, so the
// work is never lost to a start.

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('kept work start');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    caps: { global: 0 },
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

describe('POST /tasks/:id/start of a task with saved Workbench work', () => {
  it.each([Delivery.Local, Delivery.PullRequest])(
    'answers 409 on a %s project and starts nothing',
    async (delivery) => {
      const project = await api().post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        delivery,
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
        title: 'Settings: UI work',
        acceptanceCriteria: ['x'],
        areas: ['src'],
      });
      const taskId = TaskId.parse(task.id);
      daemon.state.write((ctx) => {
        setTaskKeptWork(ctx, taskId, { keptSha: 'b'.repeat(40), keptBaseSha: 'a'.repeat(40) });
      });

      const res = await fetch(`${daemon.url}/tasks/${task.id}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(409);
      expect(JSON.stringify(z.unknown().parse(await res.json()))).toContain(
        'has saved Workbench work',
      );
      expect(listWorkstreams(daemon.state.db, { projectId: project.id })).toEqual([]);
      expect(getTaskKeptWork(daemon.state.db, taskId)).not.toBeNull();
    },
  );
});
