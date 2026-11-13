import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlanExportResult, PlanImportResult, ProjectDto, type ProjectId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { bundleJson, P1_BODY } from './plan-bundle-fixture';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let out: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('plan export');
  repo = createTempRepo();
  out = tempDir('plan export out');
  daemon = await startDaemonWithProfiles({
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
  out.cleanup();
  repo.cleanup();
  data.cleanup();
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${daemon.url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

async function importedPlan() {
  const project = await apiClient(daemon.url, daemon.token).post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [
      { name: 'api', globs: ['src/api/**'] },
      { name: 'ui', globs: ['src/ui/**'] },
    ],
  });
  const projectId: ProjectId = project.id;
  const res = await post(`/projects/${projectId}/plans/import`, { bundle: bundleJson(projectId) });
  return PlanImportResult.parse(res.body).shapeId;
}

describe('POST /shapes/:shapeId/export', () => {
  it('export answers the files and they read back', async () => {
    const shapeId = await importedPlan();
    const dir = join(out.path, 'remote-host');
    const res = await post(`/shapes/${shapeId}/export`, { dir });
    expect(res.status).toBe(200);
    const result = PlanExportResult.parse(res.body);
    expect(result.files).toContain('documents/p1.md');
    expect(readFileSync(join(dir, 'documents', 'p1.md'), 'utf8')).toBe(P1_BODY);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('# Remote host');
  });

  it('a checkout answers 400 and writes nothing', async () => {
    const shapeId = await importedPlan();
    const dir = join(repo.path, 'plans');
    const res = await post(`/shapes/${shapeId}/export`, { dir });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/registered checkout|git work tree/);
    expect(existsSync(dir)).toBe(false);
  });
});
