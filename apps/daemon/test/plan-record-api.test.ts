import {
  PlanDocumentRevisionDto,
  PlanImportResult,
  PlanRecordDto,
  ProjectDto,
  type ProjectId,
  type ShapeId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { bundleJson, P1_BODY } from './plan-bundle-fixture';

// The Record view's reads, through a real daemon: the record and a revision whole, each list a page at
// a time from the daemon, and a task's Plan context as its lane got it.

type Json = Record<string, unknown>;

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('plan record');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({ 'Pair a device': [[{ do: 'turn_complete' }]] }),
    logLevel: 'info',
    caffeinate: () => null,
    watch: false,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

async function seed(): Promise<ProjectId> {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    defaultRigor: 'light',
    areas: [
      { name: 'api', globs: ['src/api/**'] },
      { name: 'ui', globs: ['src/ui/**'] },
    ],
  });
  return project.id;
}

async function importJson(projectId: ProjectId, json: Json): Promise<ShapeId> {
  const result = await api().post(`/projects/${projectId}/plans/import`, PlanImportResult, {
    bundle: json,
  });
  return result.shapeId;
}

describe('a Plan record through the daemon', () => {
  it('the record lists documents with their revisions and sections', async () => {
    const projectId = await seed();
    const shapeId = await importJson(projectId, bundleJson(projectId));
    const record = await api().get(`/shapes/${shapeId}/record`, PlanRecordDto);
    expect(record).toMatchObject({ shapeId, title: 'Remote host' });
    expect(record.importedAt).not.toBeNull();
    expect(record.origin).toMatchObject({ kind: 'claude_code', session: 'ses-abc' });
    expect(record.documents.map((d) => [d.key, d.kind, d.effortKey])).toEqual([
      ['p1', 'plan', null],
      ['s1', 'spec', 'g1'],
    ]);
    const p1 = record.documents[0];
    expect(p1?.revisions.map((r) => [r.number, r.bundleNumber, r.note, r.author])).toEqual([
      [1, 1, 'first', 'opus'],
    ]);
    expect(p1?.revisions[0]?.sections.map((s) => [s.slug, s.level])).toEqual([
      ['remote-host-plan', 1],
      ['task-1', 2],
      ['task-2', 2],
      ['task-3', 2],
      ['calls-made', 2],
    ]);
    expect(record.counts).toEqual({
      decisions: 2,
      evidence: 4,
      reviews: 1,
      questions: 2,
      tasks: 0,
    });
  });

  it('a revision body reads back byte for byte', async () => {
    const projectId = await seed();
    const shapeId = await importJson(projectId, bundleJson(projectId));
    const record = await api().get(`/shapes/${shapeId}/record`, PlanRecordDto);
    const documentId = record.documents.find((d) => d.key === 'p1')?.id;
    if (documentId === undefined) throw new Error('no p1');
    const revision = await api().get(
      `/shapes/${shapeId}/documents/${documentId}/revisions/1`,
      PlanDocumentRevisionDto,
    );
    expect(revision).toEqual({ documentId, key: 'p1', number: 1, title: 'P1', body: P1_BODY });
    await expect(
      api().get(`/shapes/${shapeId}/documents/${documentId}/revisions/2`, z.unknown()),
    ).rejects.toThrow('-> 404');
    // A key is not a document's handle.
    await expect(
      api().get(`/shapes/${shapeId}/documents/p1/revisions/1`, z.unknown()),
    ).rejects.toThrow('-> 400');
  });
});
