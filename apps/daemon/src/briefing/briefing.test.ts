import type { ContextPack, HandoffDto } from '@10db/contracts';
import { mintId } from '@10db/contracts';
import { createTestStore, insertDecision, insertSource } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import {
  buildContextPack,
  buildSessionPrompt,
  compactionReinjection,
  HANDOFF_NUDGE,
  HANDOFF_NUDGE_READ_ONLY,
  renderHandoff,
} from './index';

const task = {
  title: 'Add the badge',
  description: 'A status badge.',
  acceptanceCriteria: ['Badge renders', 'Has a test'],
};
const handoff: HandoffDto = {
  id: mintId('Handoff'),
  workstreamId: mintId('Workstream'),
  sessionId: mintId('Session'),
  content: {
    objective: {
      task: 'Add the badge',
      acceptanceCriteria: ['Badge renders'],
      nonGoals: ['No animation'],
    },
    progress: {
      done: ['Component skeleton'],
      notDone: ['Tests'],
      nextAction: 'Write the render test',
    },
    codeState: { uncommittedSummary: 'none' },
    reasoning: { decisions: ['Use Mantine Badge'], tradeOffs: [], rejected: ['Custom CSS'] },
    validation: {
      checks: [{ command: 'pnpm vitest', result: 'pass' }],
      environmentProblems: [],
    },
    continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
  },
  gitHead: 'abc123',
  gitChangedFiles: ['src/ui/badge.tsx'],
  gitCommits: ['abc123'],
  createdAt: '2026-10-13T12:00:00.000Z',
};
const emptyPack: ContextPack = {
  task,
  claims: [],
  handoff: null,
  pendingAnswer: null,
  knowledge: { decisions: [], budgetUsed: 0, droppedCount: 0, empty: true },
};
const packWithDecision: ContextPack = {
  ...emptyPack,
  knowledge: {
    decisions: [
      {
        kind: 'decision',
        id: mintId('Decision'),
        question: 'Which badge library?',
        choice: 'Mantine Badge',
        rationale: 'Already in the stack',
      },
    ],
    budgetUsed: 12,
    droppedCount: 0,
    empty: false,
  },
};
const implementStep = {
  index: 0,
  count: 1,
  role: 'implement',
  personaName: 'Implementer',
  instructions: null,
  skills: [],
  tools: 'edit',
} as const;
const base = {
  step: implementStep,
  priorResults: [],
  revisedBy: null,
  task,
  claims: [{ kind: 'area' as const, name: 'ui' }],
  handoff: null,
  answer: null,
  evidence: null,
  recovery: null,
  contextPack: emptyPack,
};

describe('buildSessionPrompt', () => {
  it('names the task on its own line, lists criteria and claims, and states the rules', () => {
    const prompt = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(prompt).toContain('Task: Add the badge\n');
    expect(prompt).toContain('- Badge renders');
    expect(prompt).toContain('area ui');
    expect(prompt).toContain('commit tool');
  });

  it('carries the handoff when continuing', () => {
    const prompt = buildSessionPrompt({
      ...base,
      handoff,
      action: { kind: 'continue_from_handoff', handoffId: handoff.id },
    });
    expect(prompt).toContain('Write the render test');
    expect(prompt).toContain('src/ui/badge.tsx');
  });

  it('carries the answer, the gate output or the recovery note', () => {
    expect(
      buildSessionPrompt({
        ...base,
        answer: { question: 'Color?', answer: 'Teal', note: null },
        action: { kind: 'answer', inboxId: mintId('InboxItem'), providerSessionId: null },
      }),
    ).toContain('Answer: Teal');
    const evidence = {
      id: mintId('Evidence'),
      workstreamId: handoff.workstreamId,
      kind: 'gate' as const,
      command: 'make gate',
      exitCode: 2,
      summary: 'FAIL badge.test.ts',
      logPath: null,
      commitShas: [],
      createdAt: handoff.createdAt,
    };
    expect(
      buildSessionPrompt({ ...base, evidence, action: { kind: 'fix', evidenceId: evidence.id } }),
    ).toContain('FAIL badge.test.ts');
    expect(
      buildSessionPrompt({
        ...base,
        recovery: { reason: 'daemon restarted', lastOp: 'op-commit-7' },
        action: { kind: 'resume', providerSessionId: 'p', reason: 'daemon restarted' },
      }),
    ).toContain('op-commit-7');
  });

  it('injects the context pack and says so when it holds no knowledge', () => {
    const empty = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(empty).toContain('Context pack');
    expect(empty).toContain('No recorded decisions');

    const full = buildSessionPrompt({
      ...base,
      contextPack: packWithDecision,
      action: { kind: 'start' },
    });
    expect(full).toContain('Which badge library?');
    expect(full).toContain('Mantine Badge');
    expect(full).not.toContain('No recorded decisions');
  });

  it('does not claim nothing applies when every decision exceeded the budget', () => {
    const prompt = buildSessionPrompt({
      ...base,
      contextPack: {
        ...emptyPack,
        knowledge: { decisions: [], budgetUsed: 0, droppedCount: 3, empty: true },
      },
      action: { kind: 'start' },
    });
    expect(prompt).toContain('3 recorded decisions exceeded the budget');
    expect(prompt).toContain('find_knowledge');
    expect(prompt).not.toContain('No recorded decisions');
  });

  it('asks for write_handoff in the nudge and re-injects the pack after compaction', () => {
    expect(HANDOFF_NUDGE).toContain('write_handoff');
    expect(renderHandoff(handoff)).toContain('Next action: Write the render test');
    expect(compactionReinjection(packWithDecision)).toContain('context pack');
    expect(compactionReinjection(packWithDecision)).toContain('Mantine Badge');
  });
});

describe('buildContextPack', () => {
  let close: () => void;
  let store: ReturnType<typeof createTestStore>['store'];
  beforeEach(() => ({ store, close } = createTestStore()));
  afterEach(() => {
    close();
  });

  const recordDecision = (
    projectId: Parameters<typeof insertDecision>[1]['projectId'],
    question: string,
    choice = 'x'.repeat(300),
  ) =>
    store.write((ctx) => {
      const sourceId = insertSource(ctx, 'builder', {});
      insertDecision(ctx, {
        projectId,
        question,
        choice,
        rationale: 'r',
        decidedBy: 'me',
        scope: 'project',
        area: null,
        sourceId,
      });
    });

  it('says so when there is no knowledge', () => {
    const { workstream } = seedWorkstream(store);
    const pack = buildContextPack(store.db, workstream);
    expect(pack.knowledge).toEqual({ decisions: [], budgetUsed: 0, droppedCount: 0, empty: true });
    expect(pack.task.title).toBe('Alpha');
  });

  it('fills the budget with relevant decisions and counts what it dropped', () => {
    const { project, workstream } = seedWorkstream(store, { title: 'Alpha badge' });
    for (let i = 0; i < 5; i += 1) recordDecision(project.id, `Badge question ${String(i)}`);
    const pack = buildContextPack(store.db, workstream, 700);
    expect(pack.knowledge.decisions.length).toBeGreaterThan(0);
    expect(pack.knowledge.decisions.length + pack.knowledge.droppedCount).toBe(5);
    expect(pack.knowledge.empty).toBe(false);
    expect(pack.knowledge.budgetUsed).toBeLessThanOrEqual(Math.ceil(700 / 4));
  });

  it('falls back to recent decisions when nothing matches the task', () => {
    const { project, workstream } = seedWorkstream(store, { title: 'Alpha' });
    recordDecision(project.id, 'Unrelated zebra topic', 'stripes');
    const pack = buildContextPack(store.db, workstream);
    expect(pack.knowledge.decisions.map((d) => d.question)).toEqual(['Unrelated zebra topic']);
    expect(pack.knowledge.empty).toBe(false);
  });

  it('is deterministic for the same state', () => {
    const { project, workstream } = seedWorkstream(store, { title: 'Alpha badge' });
    for (let i = 0; i < 3; i += 1) recordDecision(project.id, `Badge question ${String(i)}`);
    expect(buildContextPack(store.db, workstream, 600)).toEqual(
      buildContextPack(store.db, workstream, 600),
    );
  });
});

describe('buildSessionPrompt for flow steps', () => {
  const reviewStep = {
    index: 1,
    count: 2,
    role: 'review',
    personaName: 'Reviewer',
    instructions: 'Hunt for defects.',
    skills: ['review-checklist'],
    tools: 'read_only',
  } as const;
  const result = (summary: string, verdict: 'approve' | 'reject' | null) => ({
    summary,
    verdict,
    sessionId: mintId('Session'),
    at: '2026-10-17T12:00:00.000Z',
  });

  it('names the step, its persona and its skills, keeps the task line, and carries the instructions', () => {
    const prompt = buildSessionPrompt({ ...base, step: reviewStep, action: { kind: 'start' } });
    expect(prompt).toContain('Task: Add the badge\n');
    expect(prompt).toContain('Your step: 2 of 2, review, as Reviewer.');
    expect(prompt).toContain('Skills to use: review-checklist.');
    expect(prompt).toContain('How you work:\nHunt for defects.');
  });

  it('tells a read-only step it cannot write and must finish with complete_step and a verdict', () => {
    const prompt = buildSessionPrompt({ ...base, step: reviewStep, action: { kind: 'start' } });
    expect(prompt).toContain('This step is read-only');
    expect(prompt).toContain('call mcp__10db__complete_step with your findings and a verdict');
    expect(prompt).not.toContain(
      'When the acceptance criteria are met and committed, end your turn.',
    );
  });

  it('gives read-only steps a handoff nudge that asks for no commit', () => {
    expect(HANDOFF_NUDGE_READ_ONLY).toContain('mcp__10db__write_handoff');
    expect(HANDOFF_NUDGE_READ_ONLY).not.toContain('commit');
  });

  it('keeps the implement rules for an implement step', () => {
    const prompt = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(prompt).toContain('When the acceptance criteria are met and committed, end your turn.');
    expect(prompt).not.toContain('complete_step');
  });

  it('carries earlier steps’ results as data, with their verdicts', () => {
    const prompt = buildSessionPrompt({
      ...base,
      action: { kind: 'start' },
      priorResults: [
        {
          role: 'plan',
          personaName: 'Planner',
          result: result('1. Add <Badge/> to header.tsx', null),
        },
        {
          role: 'review',
          personaName: 'Reviewer',
          result: result('1. No empty-state test.', 'reject'),
        },
      ],
    });
    expect(prompt).toContain(
      'Earlier steps:\n--- plan (Planner)\n1. Add <Badge/> to header.tsx\n---',
    );
    expect(prompt).toContain('--- review (Reviewer): rejected\n1. No empty-state test.\n---');
  });
});
