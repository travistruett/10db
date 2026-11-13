import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PlanImportError,
  PlanImportPreview,
  PlanImportResult,
  ProjectDto,
  ShapeDto,
  ShapeViewDto,
  type ProjectId,
} from '@10db/contracts';
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
let effort: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('plan import');
  repo = createTempRepo();
  effort = tempDir('plan effort');
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
  effort.cleanup();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

async function post(path: string, body: unknown, token: string | null = daemon.token) {
  const res = await fetch(`${daemon.url}${path}`, {
    method: 'POST',
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

async function seed(): Promise<ProjectId> {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [
      { name: 'api', globs: ['src/api/**'] },
      { name: 'ui', globs: ['src/ui/**'] },
    ],
  });
  return project.id;
}

/** Writes the fixture bundle into the effort folder, the plan's text in a file beside it. */
function writeBundle(
  projectId: ProjectId,
  change: ((json: Record<string, unknown>) => void) | null = null,
) {
  const json = bundleJson(projectId);
  const docs = json['documents'] as { key: string; revisions: Record<string, unknown>[] }[];
  const p1 = docs.find((d) => d.key === 'p1')?.revisions[0];
  if (p1) {
    delete p1['body'];
    p1['bodyPath'] = 'docs/p1.md';
  }
  change?.(json);
  mkdirSync(join(effort.path, 'docs'), { recursive: true });
  writeFileSync(join(effort.path, 'docs', 'p1.md'), P1_BODY);
  const path = join(effort.path, 'bundle.json');
  writeFileSync(path, JSON.stringify(json));
  return path;
}

const shapesOf = (projectId: ProjectId) =>
  api().get(`/projects/${projectId}/shapes`, z.array(ShapeDto));

describe('POST /projects/:projectId/plans/import', () => {
  it('a dry run answers 200 and writes nothing', async () => {
    const projectId = await seed();
    const res = await post(`/projects/${projectId}/plans/import`, {
      bundlePath: writeBundle(projectId),
      dryRun: true,
    });
    expect(res.status).toBe(200);
    const preview = PlanImportPreview.parse(res.body);
    expect(preview).toMatchObject({ dryRun: true, shapeId: null, title: 'Remote host' });
    expect(preview.changes.documents).toEqual([
      { key: 'p1', added: [1] },
      { key: 's1', added: [1] },
    ]);
    expect(await shapesOf(projectId)).toEqual([]);
  });

  it('an import answers 201 and GET /shapes/:id shows the goal and its tasks', async () => {
    const projectId = await seed();
    const res = await post(`/projects/${projectId}/plans/import`, {
      bundlePath: writeBundle(projectId),
    });
    expect(res.status).toBe(201);
    const result = PlanImportResult.parse(res.body);
    expect(result.created).toBe(true);
    const view = await api().get(`/shapes/${result.shapeId}`, ShapeViewDto);
    expect(view.shape.importedAt).not.toBeNull();
    const goal = view.proposals.find((p) => p.key === 'g1');
    expect(goal?.kind).toBe('goal');
    expect(JSON.stringify(goal?.body)).toContain('Revoke a device');
  });

  it('the same bundle again answers 200 with no changes', async () => {
    const projectId = await seed();
    const path = writeBundle(projectId);
    expect((await post(`/projects/${projectId}/plans/import`, { bundlePath: path })).status).toBe(
      201,
    );
    const again = await post(`/projects/${projectId}/plans/import`, { bundlePath: path });
    expect(again.status).toBe(200);
    expect(PlanImportResult.parse(again.body)).toMatchObject({
      created: false,
      changes: { documents: [], proposals: { added: [], replaced: [] } },
    });
  });

  it('a refused bundle answers 400 with every issue', async () => {
    const projectId = await seed();
    const path = writeBundle(projectId, (json) => {
      const goals = json['goals'] as { tasks: Record<string, unknown>[] }[];
      const t1 = goals[0]?.tasks[0];
      if (t1) {
        t1['areas'] = ['docs'];
        t1['cites'] = ['nope'];
      }
    });
    const res = await post(`/projects/${projectId}/plans/import`, { bundlePath: path });
    expect(res.status).toBe(400);
    expect(PlanImportError.parse(res.body).errors.map((e) => e.path)).toEqual([
      'Task t1, cites: nope',
      'Task t1, areas: docs',
    ]);
    expect(await shapesOf(projectId)).toEqual([]);
  });

  it('an inline bundle imports', async () => {
    const projectId = await seed();
    const res = await post(`/projects/${projectId}/plans/import`, {
      bundle: bundleJson(projectId),
    });
    expect(res.status).toBe(201);
    expect((await shapesOf(projectId)).map((s) => s.title)).toEqual(['Remote host']);
  });

  it('a request without the token is 401', async () => {
    const projectId = await seed();
    const res = await post(
      `/projects/${projectId}/plans/import`,
      { bundle: bundleJson(projectId) },
      null,
    );
    expect(res.status).toBe(401);
  });
});
