import { ProjectDto, TaskDto, WorkstreamDto } from '@10db/contracts';
import { listInbox, recordSkip, transitionWorkstream } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { SKIPPED_DETAIL } from '../src/delivery';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { createTempRepo, tempDir, waitFor } from './fixtures';

// T4 call 12, through the composition root: a run that ends raises its item from the daemon's own
// subscriber.
describe('the daemon lists an ended run', () => {
  it("raises the item when a run nobody watched fails, through the daemon's own subscriber", async () => {
    const data = tempDir('skipped card daemon');
    const repo = createTempRepo();
    const daemon = await startDaemonWithProfiles({
      sandbox: null,
      dataDir: data.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'debug',
      caffeinate: () => null,
      watch: false,
      // A tick long enough that a started task stays where the test left it.
      tickMs: 3_600_000,
    });
    try {
      const api = apiClient(daemon.url, daemon.token);
      const project = await api.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: null,
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
        title: 'change things',
        acceptanceCriteria: ['x'],
        areas: ['src'],
        dependsOn: [],
      });
      const ws = await api.post(`/tasks/${task.id}/start`, WorkstreamDto);
      daemon.state.write((ctx) => {
        recordSkip(ctx, {
          workstreamId: ws.id,
          sessionId: null,
          toolName: 'Bash',
          toolUseId: 'tu-1',
          callKey: 'key-1',
          summary: 'curl -s https://a.example',
          kind: 'default_mode_card',
          limit: null,
          reason: 'nobody',
          source: 'broker',
        });
        transitionWorkstream(ctx, ws.id, { to: 'FAILED', fence: null, reason: 'it broke' });
      });
      const item = await waitFor(() =>
        listInbox(daemon.state.db, {}).find((i) => i.detail?.[SKIPPED_DETAIL] === ws.id),
      );
      expect(item.title).toBe('Skipped while you were away: change things');
    } finally {
      await daemon.stop();
      repo.cleanup();
      data.cleanup();
    }
  });
});
