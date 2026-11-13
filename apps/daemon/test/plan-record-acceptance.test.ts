import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PlanDocumentRevisionDto,
  PlanImportResult,
  PlanRecordDto,
  PlanRecordPage,
  PlanExportResult,
  ProjectDto,
  ShapeViewDto,
  TaskDto,
  TaskPlanContextDto,
  WorkstreamDto,
  type ProjectId,
  type ShapeId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient, quickFlowId } from './api-client';
import { createTempRepo, isolatedGitEnv, tempDir, waitForAsync } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

// Design §9's acceptance on a committed bundle, through a real daemon: import by path, nothing lost,
// a task section that never carries Review Focus, a re-import that changes only what changed, a
// lane's prompt holding its section, its shared sections and a moved anchor as moved, and an export
// whose documents are their files.

const FIXTURE = join(import.meta.dirname, 'fixtures', 'plan-bundle');
const read = (name: string) => readFileSync(join(FIXTURE, name), 'utf8');

/** The cited file at its base: two lines more above the excerpt than the fact read, so it moved. */
const PAIRING_TS = [
  '// Pairing.',
  '',
  '// The code a device types to pair.',
  '// It is shown on the host.',
  '',
  'export const PAIR_CODE_DIGITS = 6;',
  '',
].join('\n');

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let effort: { path: string; cleanup(): void };
let out: { path: string; cleanup(): void };
let adapter: FakeAdapter;
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('plan acceptance');
  repo = createTempRepo();
  effort = tempDir('plan acceptance effort');
  out = tempDir('plan acceptance export');
  mkdirSync(join(repo.path, 'src', 'api'), { recursive: true });
  writeFileSync(join(repo.path, 'src', 'api', 'pairing.ts'), PAIRING_TS);
  execFileSync('git', ['add', 'src/api/pairing.ts'], { cwd: repo.path, env: isolatedGitEnv() });
  execFileSync('git', ['commit', '-q', '-m', 'Pairing'], { cwd: repo.path, env: isolatedGitEnv() });
  adapter = new FakeAdapter({ 'Revoke a device': [[{ do: 'turn_complete' }]] });
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter,
    logLevel: 'info',
    caffeinate: () => null,
    watch: false,
  });
});
afterEach(async () => {
  await daemon.stop();
  out.cleanup();
  effort.cleanup();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);

/** The committed bundle for `projectId`, with its files beside it; `change` edits the JSON first. */
function placeBundle(
  projectId: ProjectId,
  change: (json: Record<string, unknown>) => void = () => undefined,
): string {
  const json = z.record(z.string(), z.unknown()).parse(JSON.parse(read('bundle.json')));
  json['projectId'] = projectId;
  change(json);
  for (const name of ['research.md', 'plan.md', 'plan-2.md'])
    copyFileSync(join(FIXTURE, name), join(effort.path, name));
  const path = join(effort.path, 'bundle.json');
  writeFileSync(path, JSON.stringify(json));
  return path;
}

describe('a planning effort through 10db', () => {
  it('imports, briefs a lane and exports with nothing lost', async () => {
    const project = await api().post('/projects', ProjectDto, {
      name: 'pairing',
      repoPath: repo.path,
      gateCommand: 'true',
      flowId: await quickFlowId(api()),
      areas: [{ name: 'api', globs: ['src/api/**'] }],
    });
    const importAt = `/projects/${project.id}/plans/import`;

    // 1. Import by path.
    const first = await api().post(importAt, PlanImportResult, {
      bundlePath: placeBundle(project.id),
    });
    expect(first.created).toBe(true);
    const shapeId: ShapeId = first.shapeId;

    // 2. Nothing lost: every body, finding, entry, quote and the cost.
    const { documents } = await api().get(`/shapes/${shapeId}/record`, PlanRecordDto);
    for (const [key, file] of [
      ['research', 'research.md'],
      ['plan', 'plan.md'],
    ] as const) {
      const id = documents.find((d) => d.key === key)?.id;
      const revision = await api().get(
        `/shapes/${shapeId}/documents/${String(id)}/revisions/1`,
        PlanDocumentRevisionDto,
      );
      expect(revision.body).toBe(read(file));
    }
    expect(read('plan.md')).toContain('six digits.\r\n');
    const reviews = await api().get(`/shapes/${shapeId}/record/reviews`, PlanRecordPage);
    expect(reviews.rows).toMatchObject([
      {
        key: 'plan-r1-1',
        round: 1,
        reviewer: 'fable plan reviewer',
        severityText: 'blocking, security',
        outcomeText: 'partial: the session column is a stub',
        state: 'open',
      },
      {
        key: 'plan-r1-2',
        severityText: 'follow-up',
        outcomeText: 'fixed: ten minutes, in Calls made',
        howDetail: 'Calls made now says a code lasts ten minutes.',
      },
    ]);
    const evidence = await api().get(
      `/shapes/${shapeId}/record/evidence?pageSize=100`,
      PlanRecordPage,
    );
    const bodies = new Map(
      evidence.rows.map((r) => ['body' in r ? r.key : '', 'body' in r ? r.body : null]),
    );
    expect(bodies.get('i1')).toMatchObject({
      quote: 'Plans never go in the repo.\nThey stay local, byte for byte.',
    });
    expect(bodies.get('x1')).toMatchObject({ output: 'pong from host in 3ms\n' });
    expect(bodies.get('cost')).toEqual({
      kind: 'cost',
      rows: [
        { phase: 'Research', agents: 2, tokens: 240000, approximate: true },
        { phase: 'Total', agents: null, tokens: 240000, approximate: true },
      ],
      note: "From the subagents' reported totals.",
    });

    // 3. A task's section ends before the next task, and the shared sections between the tasks
    // carry neither.
    const record = await api().get(`/shapes/${shapeId}/record`, PlanRecordDto);
    const plan = record.documents.find((d) => d.key === 'plan')?.revisions[0];
    const textOf = (slug: string) => {
      const s = plan?.sections.find((x) => x.slug === slug);
      return s ? read('plan.md').slice(s.start, s.end) : '';
    };
    expect(textOf('task-2')).toMatch(/^### Task 2: Revoke a device\n/);
    expect(textOf('task-2')).not.toContain('Review Focus');
    expect(textOf('task-2')).not.toContain('Calls made');
    expect(textOf('task-1')).toContain('# not a heading');
    expect(textOf('review-focus')).not.toContain('### Task 2');
    expect(plan?.sections.map((s) => s.slug)).not.toContain('not-a-heading');

    // 4. A second revision of the plan and a changed fact: only those change.
    const again = await api().post(importAt, PlanImportResult, {
      bundlePath: placeBundle(project.id, (json) => {
        // zod hands back copies, so the edited lists are put back.
        const docs = z.array(z.record(z.string(), z.unknown())).parse(json['documents']);
        json['documents'] = docs.map((d) =>
          d['key'] === 'plan'
            ? {
                ...d,
                revisions: [
                  ...z.array(z.unknown()).parse(d['revisions']),
                  { number: 2, bodyPath: 'plan-2.md', at: '2026-11-13T08:00:00.000Z' },
                ],
              }
            : d,
        );
        const entries = z.array(z.record(z.string(), z.unknown())).parse(json['entries']);
        json['entries'] = entries.map((e) =>
          e['key'] === 'f1' ? { ...e, body: { claim: 'PAIR_CODE_DIGITS is six.' } } : e,
        );
      }),
    });
    expect(again.created).toBe(false);
    expect(again.changes).toMatchObject({
      documents: [{ key: 'plan', added: [2] }],
      entries: { added: [], changed: ['f1'], superseded: [] },
      findings: { added: [], changed: [] },
      proposals: { added: [], replaced: [], changeTasks: [], additions: [] },
    });

    // 5. Convert, start Revoke a device (it waits on nothing), and read its prompt.
    const view = await api().get(`/shapes/${shapeId}`, ShapeViewDto);
    await api().post(`/shapes/${shapeId}/convert`, z.unknown(), {
      proposalIds: view.proposals.filter((p) => p.state === 'pending').map((p) => p.id),
    });
    const tasks = await api().get(`/projects/${project.id}/tasks`, z.array(TaskDto));
    const revoke = tasks.find((t) => t.title === 'Revoke a device');
    if (!revoke) throw new Error('Convert made no Revoke a device');
    await api().post(`/tasks/${revoke.id}/start`, WorkstreamDto);
    const context = await waitForAsync(async () => {
      const ctx = await api().get(`/tasks/${revoke.id}/plan-context`, TaskPlanContextDto);
      return ctx.packed === null ? undefined : ctx;
    }, 20_000);
    const prompt = adapter.prompts[0]?.prompt ?? '';
    expect(prompt).toContain(context.packed?.text);
    const section = textOf('task-2');
    expect(prompt).toContain(`Your section (plan#task-2):\n${section}`);
    for (const shared of ['starting-point', 'global-constraints'])
      expect(prompt.split(textOf(shared)).length - 1).toBe(1);
    expect(prompt).toContain(
      '- f1: PAIR_CODE_DIGITS is six. — Anchor moved: src/api/pairing.ts:3→6',
    );
    expect(prompt).not.toMatch(/src\/api\/pairing\.ts:3, checked at/);
    expect(prompt).toContain(
      '- d1: In the database, local only — why: A plan in the repository leaks (lasting)',
    );
    expect(prompt).toContain('- blocking, security: A revoked device keeps its session');

    // 6. The export's documents are their latest revisions' files, byte for byte.
    const dir = join(out.path, 'pairing');
    const exported = await api().post(`/shapes/${shapeId}/export`, PlanExportResult, { dir });
    expect(exported.files).toContain('documents/plan.md');
    expect(readFileSync(join(dir, 'documents', 'research.md'), 'utf8')).toBe(read('research.md'));
    expect(readFileSync(join(dir, 'documents', 'plan.md'), 'utf8')).toBe(read('plan-2.md'));
  });
});
