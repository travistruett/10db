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
  const UUID_V7 = /^tsk_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('mints a prefixed UUIDv7 that parses back', () => {
    const id = mintId('Task');
    expect(id).toMatch(UUID_V7);
    expect(TaskId.parse(id)).toBe(id);
  });

  it('mints IDs that sort in creation order within one millisecond', () => {
    const ids = Array.from({ length: 1000 }, () => mintId('Task'));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['wrong prefix', 'ws_0199f1c2-7a3b-7c4d-8e5f-0123456789ab'],
    ['a ULID', 'tsk_01JA2B3C4D5E6F7G8H9J0K1M2N'],
    ['a UUIDv4', 'tsk_0199f1c2-7a3b-4c4d-8e5f-0123456789ab'],
    ['upper case', 'tsk_0199F1C2-7A3B-7C4D-8E5F-0123456789AB'],
    ['a bad variant', 'tsk_0199f1c2-7a3b-7c4d-ce5f-0123456789ab'],
    ['no prefix', '0199f1c2-7a3b-7c4d-8e5f-0123456789ab'],
  ])('rejects %s', (_name, value) => {
    expect(TaskId.safeParse(value).success).toBe(false);
  });

  it('rejects an ID minted for another kind', () => {
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
      fallbackAccountId: null,
      usageHandoffAt: 0.95,
    });
    expect(parsed.hazards.map((h) => h.name)).toEqual(['migrations', 'deps', 'harness']);
    expect(parsed.allowedCommands).toEqual([]);
  });

  it('takes the extra allowed commands and rejects one that is not a plain prefix', () => {
    const base = {
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
    };
    expect(ProjectInput.parse({ ...base, allowedCommands: ['pnpm test'] }).allowedCommands).toEqual(
      ['pnpm test'],
    );
    expect(ProjectInput.safeParse({ ...base, allowedCommands: ['pnpm --run'] }).success).toBe(
      false,
    );
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
    [{ kind: 'uncommitted', paths: ['src/api/a.ts'] }],
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
