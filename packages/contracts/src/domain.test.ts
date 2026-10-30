import { describe, expect, it } from 'vitest';
import {
  EvidenceDto,
  HandoffInput,
  McpToolInputs,
  mintId,
  NextAction,
  ProjectInput,
  ProjectPatch,
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

describe('a project with no gate command', () => {
  const base = {
    name: 'demo',
    repoPath: '/tmp/demo',
    areas: [{ name: 'src', globs: ['src/**'] }],
  };

  it('ProjectInput accepts no gate command and defaults it to null', () => {
    expect(ProjectInput.parse(base).gateCommand).toBeNull();
    expect(ProjectInput.parse({ ...base, gateCommand: null }).gateCommand).toBeNull();
    expect(ProjectInput.safeParse({ ...base, gateCommand: '' }).success).toBe(false);
  });

  it('ProjectPatch can clear the gate command', () => {
    expect(ProjectPatch.parse({ gateCommand: null })).toEqual({ gateCommand: null });
    expect(ProjectPatch.safeParse({ gateCommand: '' }).success).toBe(false);
  });
});

describe('a project with a changed-packages check command', () => {
  const base = {
    name: 'demo',
    repoPath: '/tmp/demo',
    gateCommand: 'make gate',
    areas: [{ name: 'src', globs: ['src/**'] }],
  };

  it('ProjectInput defaults it to null and rejects an empty one', () => {
    expect(ProjectInput.parse(base).changedCheckCommand).toBeNull();
    expect(
      ProjectInput.parse({ ...base, changedCheckCommand: 'make check-changed' })
        .changedCheckCommand,
    ).toBe('make check-changed');
    expect(ProjectInput.safeParse({ ...base, changedCheckCommand: '' }).success).toBe(false);
  });

  it('ProjectPatch can set and clear it', () => {
    expect(ProjectPatch.parse({ changedCheckCommand: 'make check-changed' })).toEqual({
      changedCheckCommand: 'make check-changed',
    });
    expect(ProjectPatch.parse({ changedCheckCommand: null })).toEqual({
      changedCheckCommand: null,
    });
    expect(ProjectPatch.safeParse({ changedCheckCommand: '' }).success).toBe(false);
  });
});

describe('EvidenceDto', () => {
  const common = {
    id: mintId('Evidence'),
    workstreamId: mintId('Workstream'),
    summary: 'note',
    logPath: null,
    commitShas: [],
    createdAt: '2026-10-28T12:00:00.000Z',
  };

  it.each([
    [
      'gate with a command and exit code',
      { kind: 'gate', command: 'make gate', exitCode: 0 },
      true,
    ],
    ['agent with a command and exit code', { kind: 'agent', command: 'x', exitCode: 1 }, true],
    ['builder with neither', { kind: 'builder', command: null, exitCode: null }, true],
    [
      'agent without a command or exit code',
      { kind: 'agent', command: null, exitCode: null },
      false,
    ],
    ['gate without a command', { kind: 'gate', command: null, exitCode: null }, false],
    ['gate without an exit code', { kind: 'gate', command: 'make gate', exitCode: null }, false],
    ['builder with a command', { kind: 'builder', command: 'x', exitCode: 0 }, false],
  ])('%s', (_name, fields, ok) => {
    expect(EvidenceDto.safeParse({ ...common, ...fields }).success).toBe(ok);
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

  it('accepts pull request delivery with no title prefix', () => {
    const parsed = ProjectInput.safeParse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
      delivery: 'pull_request',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.prTitlePrefix).toBeNull();
  });

  it('drops the project-level model and effort', () => {
    const parsed = ProjectInput.parse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
      model: 'opus',
      effort: 'high',
    });
    expect(parsed).not.toHaveProperty('model');
    expect(parsed).not.toHaveProperty('effort');
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

  it.each([
    ['absent', {}, false],
    ['on', { sandboxLoopback: true }, true],
  ])('reads the localhost switch when it is %s', (_name, given, expected) => {
    const parsed = ProjectInput.parse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
      ...given,
    });
    expect(parsed.sandboxLoopback).toBe(expected);
  });

  it('patches the localhost switch and rejects a non-boolean one', () => {
    expect(ProjectPatch.parse({ sandboxLoopback: true })).toEqual({ sandboxLoopback: true });
    expect(ProjectPatch.safeParse({ sandboxLoopback: 'on' }).success).toBe(false);
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
