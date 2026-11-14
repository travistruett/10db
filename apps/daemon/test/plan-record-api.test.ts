import {
  DecisionId,
  PlanDocumentRevisionDto,
  PlanImportResult,
  PlanRecordDto,
  PlanRecordPage,
  ProjectDto,
  ShapeOfDto,
  ShapeProposalId,
  ShapeViewDto,
  TaskDto,
  TaskPlanContextDto,
  WorkstreamDto,
  type ProjectId,
  type ShapeId,
  type TaskId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir, waitForAsync } from './fixtures';
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

/** The fixture with `n` findings on p1's first revision, the odd ones open and the even resolved. */
function withFindings(projectId: ProjectId, n: number): Json {
  const json = bundleJson(projectId);
  json['findings'] = Array.from({ length: n }, (_, i) => ({
    key: `p1-r1-${String(i + 1)}`,
    document: 'p1',
    revision: 1,
    round: 1,
    reviewer: 'fable plan reviewer',
    severity: i % 3 === 0 ? 'high' : 'low',
    severityText: i % 3 === 0 ? 'blocking' : 'follow-up',
    text: `Finding ${String(i + 1)}`,
    state: i % 2 === 0 ? 'open' : 'resolved',
  }));
  return json;
}

const page = (shapeId: ShapeId, list: string, query = '') =>
  api().get(`/shapes/${shapeId}/record/${list}${query}`, PlanRecordPage);

/** Converts every pending proposal and starts `Pair a device`, waiting until its lane was packed. */
async function startPairing(projectId: ProjectId, shapeId: ShapeId): Promise<TaskId> {
  const view = await api().get(`/shapes/${shapeId}`, ShapeViewDto);
  await api().post(`/shapes/${shapeId}/convert`, z.unknown(), {
    proposalIds: view.proposals.filter((p) => p.state === 'pending').map((p) => p.id),
  });
  const tasks = await api().get(`/projects/${projectId}/tasks`, z.array(TaskDto));
  const task = tasks.find((t) => t.title === 'Pair a device');
  if (!task) throw new Error('Convert made no Pair a device');
  await api().post(`/tasks/${task.id}/start`, WorkstreamDto);
  await waitForAsync(async () => {
    const ctx = await api().get(`/tasks/${task.id}/plan-context`, TaskPlanContextDto);
    return ctx.packed !== null && ctx.checks.length > 0;
  }, 20_000);
  return task.id;
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

  it('reviews page 25 at a time with the total', async () => {
    const projectId = await seed();
    const shapeId = await importJson(projectId, withFindings(projectId, 30));
    const first = await page(shapeId, 'reviews');
    const second = await page(shapeId, 'reviews', '?page=2');
    if (first.list !== 'reviews' || second.list !== 'reviews') throw new Error('not reviews');
    expect([first.rows.length, first.total, first.page, first.pageSize]).toEqual([25, 30, 1, 25]);
    expect([second.rows.length, second.total, second.page]).toEqual([5, 30, 2]);
    const keys = [...first.rows, ...second.rows].map((r) => r.key);
    expect(new Set(keys).size).toBe(30);
    // Sorted by document, revision, round and key, key by its number.
    expect(keys.slice(0, 3)).toEqual(['p1-r1-1', 'p1-r1-2', 'p1-r1-3']);
    expect(first.groups).toEqual([
      { document: 'p1', revision: 1, round: 1, total: 30, high: 10, medium: 0, low: 20 },
    ]);
    expect(first.rows[0]).toMatchObject({
      reviewer: 'fable plan reviewer',
      reviewerKind: 'imported',
      severityText: 'blocking',
    });
    const past = await page(shapeId, 'reviews', '?page=9');
    expect([past.page, past.rows.length]).toEqual([2, 5]);
  });

  it('a state filter narrows reviews', async () => {
    const projectId = await seed();
    const shapeId = await importJson(projectId, withFindings(projectId, 30));
    const open = await page(shapeId, 'reviews', '?state=open&pageSize=50');
    expect(open.total).toBe(15);
    expect(open.rows.every((r) => 'state' in r && r.state === 'open')).toBe(true);
    const searched = await page(shapeId, 'reviews', '?q=finding%2012');
    expect(searched.rows.map((r) => ('key' in r ? r.key : null))).toEqual(['p1-r1-12']);
  });

  it('questions list pending decisions without decidedAt', async () => {
    const projectId = await seed();
    const shapeId = await importJson(projectId, bundleJson(projectId));
    const questions = await page(shapeId, 'questions');
    if (questions.list !== 'questions') throw new Error('not questions');
    expect(questions.rows.every((r) => ShapeProposalId.safeParse(r.id).success)).toBe(true);
    expect(questions.rows.map((r) => ({ ...r, id: 'checked above' }))).toEqual([
      {
        id: 'checked above',
        key: 'q1',
        source: 'question',
        text: 'Which port?',
        for: 'designer',
        about: 't1',
        blocks: 'P2',
        state: 'pending',
      },
      {
        id: 'checked above',
        key: 'd2',
        source: 'decision',
        text: 'Which port for pairing?',
        for: null,
        about: null,
        blocks: null,
        state: 'pending',
      },
    ]);
    const decisions = await page(shapeId, 'decisions');
    expect(decisions.rows).toMatchObject([
      {
        key: 'd1',
        alternatives: [{ option: 'Docs PRs', whyNot: 'They land in the repo' }],
        quote: 'Plans never go in the repo.',
        lasting: true,
        decidedAt: '2026-11-12',
        decisionId: null,
      },
      { key: 'd2', lasting: false, decidedAt: null },
    ]);
  });

  it('tasks name their planRef, and evidence shows each task newest check', async () => {
    const projectId = await seed();
    const shapeId = await importJson(projectId, bundleJson(projectId));
    const taskId = await startPairing(projectId, shapeId);

    const tasks = await page(shapeId, 'tasks', '?pageSize=100');
    const record = await api().get(`/shapes/${shapeId}/record`, PlanRecordDto);
    const documentId = record.documents.find((d) => d.key === 'p1')?.id;
    expect(tasks.rows).toContainEqual({
      taskId,
      key: 't1',
      title: 'Pair a device',
      planRef: { documentId, document: 'p1', revision: 1, section: 'task-1' },
    });
    expect(tasks.rows).toContainEqual(
      expect.objectContaining({ key: 't4', title: 'Document pairing', planRef: null }),
    );

    const evidence = await page(shapeId, 'evidence', '?kind=fact');
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({
      key: 'f1',
      version: 1,
      // The temp repository has no src/runner.ts, so its anchor is nowhere to be found.
      checks: [
        {
          taskId,
          title: 'Pair a device',
          results: [{ entryKey: 'f1', anchorIndex: 0, result: 'changed' }],
        },
      ],
    });
    const decisions = await page(shapeId, 'decisions');
    const d1 = decisions.rows[0];
    expect(d1).toMatchObject({ key: 'd1', state: 'accepted' });
    // d1 is lasting, so Convert wrote it to Knowledge.
    expect(DecisionId.safeParse(d1 && 'decisionId' in d1 ? d1.decisionId : null).success).toBe(
      true,
    );
  });

  it('a task plan context shows what the lane got after a fact and a finding changed', async () => {
    const projectId = await seed();
    const json = bundleJson(projectId);
    const findings = json['findings'] as Json[];
    if (findings[0]) Object.assign(findings[0], { section: 'task-1', state: 'open' });
    const shapeId = await importJson(projectId, json);
    const taskId = await startPairing(projectId, shapeId);
    const before = await api().get(`/tasks/${taskId}/plan-context`, TaskPlanContextDto);
    expect(before.context).toEqual({
      shapeId,
      title: 'Remote host',
      ref: 'p1#task-1',
      revision: 1,
    });
    expect(before.packed?.text).toContain('The runner packs the context once per session.');
    expect(before.packed?.text).toContain('Revoked devices keep their session');

    const changed = bundleJson(projectId);
    const entries = changed['entries'] as { key: string; body: Json }[];
    const fact = entries.find((e) => e.key === 'f1');
    if (fact) fact.body = { claim: 'The runner packs twice.' };
    const later = changed['findings'] as Json[];
    if (later[0])
      Object.assign(later[0], { section: 'task-1', state: 'open', text: 'Now worded otherwise' });
    await importJson(projectId, changed);

    const after = await api().get(`/tasks/${taskId}/plan-context`, TaskPlanContextDto);
    expect(after.packed).toEqual(before.packed);
    expect(after.packed?.text).not.toContain('The runner packs twice.');
    expect(after.packed?.text).not.toContain('Now worded otherwise');
  });

  it('GET /goals/:id/shape names the Plan title', async () => {
    const projectId = await seed();
    const shapeId = await importJson(projectId, bundleJson(projectId));
    const taskId = await startPairing(projectId, shapeId);
    const tasks = await api().get(`/projects/${projectId}/tasks`, z.array(TaskDto));
    const goalId = tasks.find((t) => t.id === taskId)?.goalId ?? null;
    if (goalId === null) throw new Error('t1 has no goal');
    expect(await api().get(`/goals/${goalId}/shape`, ShapeOfDto)).toEqual({
      shapeId,
      title: 'Remote host',
    });
    expect(await api().get(`/tasks/${taskId}/shape`, ShapeOfDto)).toEqual({
      shapeId,
      title: 'Remote host',
    });
  });

  it('a task with no Plan has no Plan context', async () => {
    const projectId = await seed();
    const task = await api().post(`/projects/${projectId}/tasks`, TaskDto, {
      title: 'By hand',
      acceptanceCriteria: ['done'],
      areas: ['api'],
    });
    expect(await api().get(`/tasks/${task.id}/plan-context`, TaskPlanContextDto)).toEqual({
      context: null,
      packed: null,
      checks: [],
    });
    expect(await api().get(`/tasks/${task.id}/shape`, ShapeOfDto)).toEqual({
      shapeId: null,
      title: null,
    });
  });
});
