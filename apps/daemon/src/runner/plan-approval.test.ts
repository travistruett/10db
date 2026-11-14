import { activeClaims, getWorkstreamRow, listInbox } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';

// A rigor whose row asks the builder to approve the plan parks the task on a `plan` card between the
// planning steps and Build, and only the builder's answer to that card moves it.

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

const planResult = (opId: string, text: string) => ({
  do: 'mcp' as const,
  tool: 'complete_step',
  args: { opId, summary: text, verdict: null },
});
const approve = (opId: string) => ({
  do: 'mcp' as const,
  tool: 'complete_step',
  args: { opId, summary: 'Looks right.', verdict: 'approve' },
});
const turn = { do: 'turn_complete' as const };

const ws = (id: Parameters<typeof getWorkstreamRow>[1]) => getWorkstreamRow(engine.store.db, id);
const planCards = () => listInbox(engine.store.db, {}).filter((i) => i.kind === 'plan');
const openPlanCards = () => planCards().filter((i) => i.state === 'OPEN');

/** Runs the lane until the workstream stops queueing: it waits, or it is done or failed. */
async function runWhileQueued(id: Parameters<typeof ws>[0]): Promise<void> {
  for (let i = 0; i < 10 && ws(id).state === 'QUEUED'; i += 1) {
    engine.launch(id);
    await engine.runner.idle();
  }
}

/** A Critical task, as its row runs it, with Plan Review before Build. */
const critical = (approvesPlan: boolean) =>
  engine.addTask('Alpha', ['api'], [], {
    flow: 'full',
    criteria: 4,
    riskTags: ['security'],
    approvesPlan,
  });

describe('parking a task for the builder to approve its plan', () => {
  it('parks after Plan Review on one plan card holding the plan, with no lane and the claims kept', async () => {
    engine = await createTestEngine({
      Alpha: [
        [planResult('op-plan-0001', 'PLAN: edit src/api/a.txt.'), turn],
        [approve('op-plan-0002'), turn],
      ],
    });
    const { workstream } = critical(true);
    await runWhileQueued(workstream.id);
    const [card] = openPlanCards();
    expect(openPlanCards()).toHaveLength(1);
    expect(ws(workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      currentSessionId: null,
      stepIndex: 1,
      nextAction: { kind: 'plan_approval', inboxId: card?.id },
    });
    expect(card).toMatchObject({
      kind: 'plan',
      options: [{ label: 'approve' }, { label: 'send_back' }],
      targets: [{ workstreamId: workstream.id }],
    });
    expect(card?.body).toContain('PLAN: edit src/api/a.txt.');
    expect(ws(workstream.id).steps.map((s) => s.status)).toEqual([
      'done',
      'done',
      'pending',
      'pending',
      'pending',
    ]);
    expect(activeClaims(engine.store.db, workstream.id).length).toBeGreaterThan(0);
    expect(ws(workstream.id).leaseOwner).toBeNull();
    expect(engine.runner.isRunning(workstream.id)).toBe(false);
    // Build has not started: only the two planning sessions ran.
    expect(engine.adapter.prompts).toHaveLength(2);
  });

  it.each([
    { name: 'a Critical row that does not ask for approval', flow: 'critical' },
    { name: 'a Careful task', flow: 'careful' },
  ])('does not park for $name', async ({ flow }) => {
    engine = await createTestEngine({
      Alpha: [
        [planResult('op-plan-0011', 'PLAN'), turn],
        [approve('op-plan-0012'), turn],
      ],
    });
    const { workstream } =
      flow === 'careful'
        ? engine.addTask('Alpha', ['api'], [], { flow: 'careful' })
        : critical(false);
    await runWhileQueued(workstream.id);
    expect(planCards()).toEqual([]);
    expect(ws(workstream.id).state).not.toBe('WAITING_HUMAN');
    expect(ws(workstream.id).stepIndex).toBeGreaterThanOrEqual(
      ws(workstream.id).steps.findIndex((s) => s.role === 'implement'),
    );
  });
});
