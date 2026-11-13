import { PlanImportInput, ShapeProposalState, type ProjectId, type TaskId } from '@10db/contracts';
import {
  getTaskContext,
  getWorkstream,
  insertWorkstream,
  listEventsAfter,
  listShapeLinks,
  listShapeProposals,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContextPack, renderPlanContext } from '../src/briefing';
import { createPlanRecordServices } from '../src/daemon/plan-record-services';
import { convertProposals } from '../src/shape/convert';
import { createTestEngine, type TestEngine } from './engine';
import { waitFor } from './fixtures';
import { bundleJson } from './plan-bundle-fixture';

// The record through the real pipeline: imported by the service, converted, and read by a lane
// whose prompt carries its Plan block and whose plan tools answer from its own Plan only.

let engine: TestEngine | null = null;
afterEach(async () => {
  await engine?.close();
  engine = null;
});

type Json = Record<string, unknown>;

/** The fixture cut to one goal of two tasks, the first of which depends on nothing. */
function twoTaskBundle(projectId: ProjectId): Json {
  const json = bundleJson(projectId);
  json['goals'] = (json['goals'] as Json[]).slice(0, 1);
  json['tasks'] = [];
  json['questions'] = [];
  return json;
}

describe('a Plan through the pipeline', () => {
  it('a lane gets its Plan block and reads only its own Plan through its tools', async () => {
    engine = await createTestEngine({
      'Pair a device': [
        [
          { do: 'mcp', tool: 'get_plan_section', args: { ref: 'p1#task-2' } },
          { do: 'mcp', tool: 'get_plan_section', args: { ref: 'q9#only' } },
          { do: 'turn_complete' },
        ],
      ],
    });
    const e = engine;
    const services = createPlanRecordServices({
      state: e.state,
      dataDir: e.dataDir,
      worktreeRoot: e.dataDir,
      sandboxRoots: [],
    });
    const imported = await services.importPlan(
      e.project.id,
      PlanImportInput.parse({ bundle: twoTaskBundle(e.project.id) }),
    );
    if (imported.kind !== 'imported') throw new Error(JSON.stringify(imported));
    // A second Plan holds a document the first doesn't.
    const other = twoTaskBundle(e.project.id);
    other['id'] = 'another-plan';
    (other['documents'] as Json[]).push({
      key: 'q9',
      kind: 'guide',
      title: 'Only elsewhere',
      revisions: [{ number: 1, body: '# Only\n', at: '2026-11-12T08:00:00.000Z' }],
    });
    const second = await services.importPlan(
      e.project.id,
      PlanImportInput.parse({ bundle: other }),
    );
    expect(second.kind).toBe('imported');

    const shapeId = imported.result.shapeId;
    const converted = e.state.write((ctx) =>
      convertProposals(
        ctx,
        shapeId,
        listShapeProposals(ctx.tx, shapeId)
          .filter((p) => p.state === ShapeProposalState.Pending)
          .map((p) => p.id),
      ),
    );
    if (!converted.ok) throw new Error(converted.errors.join('; '));
    const taskId: TaskId | null =
      listShapeLinks(e.store.db, shapeId).find((l) => l.key === 't1')?.taskId ?? null;
    if (taskId === null) throw new Error('no t1');
    const workstream = e.state.write((ctx) =>
      insertWorkstream(ctx, taskId, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    );
    e.launch(workstream.id);
    await waitFor(() => e.adapter.observations.filter((o) => o.kind === 'mcp_result').length === 2);

    const prompt = e.adapter.prompts[0]?.prompt ?? '';
    const packed = getTaskContext(e.store.db, taskId)?.packedText ?? '';
    const plan = buildContextPack(e.store.db, getWorkstream(e.store.db, workstream.id)).plan;
    if (plan === null) throw new Error('no plan in the pack');
    expect(packed).toBe(renderPlanContext(plan).join('\n'));
    expect(prompt).toContain(packed);
    expect(prompt).toContain(
      'Your section (p1#task-1):\n## Task 1: Pair a device\nPair it over the tailnet.  \n',
    );

    const event = listEventsAfter(e.store.db, 0, 100_000).find(
      (ev) => ev.type === 'context.packed' && ev.data['workstreamId'] === workstream.id,
    );
    const included = (event?.data['plan'] as { included: { key: string }[] } | undefined)?.included;
    expect(included?.map((i) => i.key).sort()).toEqual(['d1', 'f1', 'i1', 'n1', 'x1']);

    const [own, foreign] = e.adapter.observations.filter((o) => o.kind === 'mcp_result');
    expect(own?.detail).toMatchObject({ tool: 'get_plan_section', isError: false });
    expect(String(own?.detail['text'])).toContain('## Task 2: Revoke a device');
    expect(foreign?.detail).toMatchObject({ tool: 'get_plan_section', isError: true });
    expect(String(foreign?.detail['text'])).toContain('q9#only');
  });
});
