import { describe, expect, it } from 'vitest';
import {
  HandoffInput,
  McpToolInputs,
  mintId,
  NextAction,
  ProjectInput,
  TaskId,
  WorkstreamId,
} from './index';

describe('ids', () => {
  it('mints prefixed sortable IDs that parse back', () => {
    const a = mintId('Task');
    const b = mintId('Task');
    expect(a).toMatch(/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(TaskId.parse(a)).toBe(a);
  });

  it('rejects an ID with the wrong prefix', () => {
    expect(WorkstreamId.safeParse(mintId('Task')).success).toBe(false);
  });
});

describe('ProjectInput', () => {
  it('fills the starting-heuristic defaults', () => {
    const parsed = ProjectInput.parse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    expect(parsed).toMatchObject({
      maxLanes: 2,
      handoffPct: 40,
      nudgePct: 50,
      humanWaitMinutes: 10,
      billingMode: 'subscription',
    });
    expect(parsed.hazards.map((h) => h.name)).toEqual(['migrations', 'deps', 'harness']);
  });

  it('rejects a nudge threshold at or below the handoff threshold', () => {
    const result = ProjectInput.safeParse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
      handoffPct: 80,
      nudgePct: 80,
    });
    expect(result.success).toBe(false);
  });
});

describe('NextAction', () => {
  it.each([
    [{ kind: 'start' }],
    [{ kind: 'verify' }],
    [{ kind: 'resume', providerSessionId: 'abc', reason: 'daemon restarted' }],
  ])('accepts %j', (value) => {
    expect(NextAction.parse(value)).toEqual(value);
  });
});

describe('MCP tool inputs', () => {
  it('requires two to four options on ask_human', () => {
    const base = { opId: 'op-00000001', category: 'design', question: 'Which?' };
    expect(
      McpToolInputs.ask_human.safeParse({ ...base, options: [{ label: 'A', description: 'a' }] })
        .success,
    ).toBe(false);
    expect(
      McpToolInputs.ask_human.safeParse({
        ...base,
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ],
      }).success,
    ).toBe(true);
  });

  it('requires a next action in the handoff', () => {
    const handoff = {
      objective: { task: 't', acceptanceCriteria: ['a'], nonGoals: [] },
      progress: { done: [], notDone: [], nextAction: '' },
      codeState: { uncommittedSummary: '' },
      reasoning: { decisions: [], tradeOffs: [], rejected: [] },
      validation: { checks: [], environmentProblems: [] },
      continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
    };
    expect(HandoffInput.safeParse(handoff).success).toBe(false);
  });
});
