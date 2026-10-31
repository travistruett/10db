import type { ContextPack, HandoffDto, NextAction, StepResult } from '@10db/contracts';
import { mintId } from '@10db/contracts';
import { createTestStore, insertDecision, insertSource } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import {
  buildContextPack,
  buildSessionPrompt,
  compactionReinjection,
  HANDOFF_FIRM_NUDGE_ACCOUNT,
  HANDOFF_NUDGE,
  HANDOFF_NUDGE_ACCOUNT,
  HANDOFF_NUDGE_ACCOUNT_READ_ONLY,
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
  previousResult: null,
  earlierResults: [],
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

  it('briefs a fix from a handoff written after the gate failed, and not from an older one', () => {
    const failed = {
      id: mintId('Evidence'),
      workstreamId: handoff.workstreamId,
      kind: 'gate' as const,
      command: 'make gate',
      exitCode: 2,
      summary: 'FAIL badge.test.ts',
      logPath: null,
      commitShas: [],
    };
    const fix = { kind: 'fix' as const, evidenceId: failed.id };
    const before = new Date(Date.parse(handoff.createdAt) - 60_000).toISOString();
    const after = new Date(Date.parse(handoff.createdAt) + 60_000).toISOString();
    const cutOff = buildSessionPrompt({
      ...base,
      handoff,
      evidence: { ...failed, createdAt: before },
      action: fix,
    });
    expect(cutOff).toContain('Write the render test');
    expect(cutOff).toContain('FAIL badge.test.ts');
    expect(
      buildSessionPrompt({
        ...base,
        handoff,
        evidence: { ...failed, createdAt: after },
        action: fix,
      }),
    ).not.toContain('Write the render test');
  });

  it("briefs a fresh session from the handoff before the builder's answer", () => {
    const answer = { question: 'Color?', answer: 'Teal', note: null };
    const fresh = buildSessionPrompt({
      ...base,
      handoff,
      answer,
      action: { kind: 'answer', inboxId: mintId('InboxItem'), providerSessionId: null },
    });
    expect(fresh).toContain('Write the render test');
    expect(fresh.indexOf('Write the render test')).toBeLessThan(fresh.indexOf('Answer: Teal'));
    const resumed = buildSessionPrompt({
      ...base,
      handoff,
      answer,
      action: { kind: 'answer', inboxId: mintId('InboxItem'), providerSessionId: 'p1' },
    });
    expect(resumed).toContain('Answer: Teal');
    expect(resumed).not.toContain('Write the render test');
    expect(
      buildSessionPrompt({
        ...base,
        answer,
        action: { kind: 'answer', inboxId: mintId('InboxItem'), providerSessionId: null },
      }),
    ).toContain('inspect git status first');
  });

  it('puts the gate output a fresh answer session was fixing between the handoff and the answer', () => {
    const prompt = buildSessionPrompt({
      ...base,
      handoff,
      answer: { question: 'Color?', answer: 'Teal', note: null },
      evidence: {
        id: mintId('Evidence'),
        workstreamId: handoff.workstreamId,
        kind: 'gate',
        command: 'make gate',
        exitCode: 2,
        summary: 'FAIL badge.test.ts',
        logPath: null,
        commitShas: [],
        createdAt: handoff.createdAt,
      },
      action: { kind: 'answer', inboxId: mintId('InboxItem'), providerSessionId: null },
    });
    const at = (text: string) => prompt.indexOf(text);
    expect(at('Write the render test')).toBeLessThan(at('FAIL badge.test.ts'));
    expect(at('FAIL badge.test.ts')).toBeLessThan(at('Answer: Teal'));
  });

  it('gives a resumed answer no gate text even when evidence is passed', () => {
    const prompt = buildSessionPrompt({
      ...base,
      handoff,
      answer: { question: 'Color?', answer: 'Teal', note: null },
      evidence: {
        id: mintId('Evidence'),
        workstreamId: handoff.workstreamId,
        kind: 'gate',
        command: 'make gate',
        exitCode: 2,
        summary: 'FAIL badge.test.ts',
        logPath: null,
        commitShas: [],
        createdAt: handoff.createdAt,
      },
      action: { kind: 'answer', inboxId: mintId('InboxItem'), providerSessionId: 'p1' },
    });
    expect(prompt).toContain('Answer: Teal');
    expect(prompt).not.toContain('FAIL badge.test.ts');
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
    const builder = {
      ...evidence,
      kind: 'builder' as const,
      command: null,
      exitCode: null,
      summary: 'Rename the badge prop',
    };
    const sentBack = buildSessionPrompt({
      ...base,
      evidence: builder,
      action: { kind: 'fix', evidenceId: builder.id },
    });
    expect(sentBack).toContain('The builder sent the work back: Rename the badge prop');
    expect(sentBack).toContain('Address it, commit, and end your turn.');
    expect(sentBack).not.toContain('The gate failed');
    // A read-only step a retry restarted with the builder's note has nothing to commit.
    const toReviewer = buildSessionPrompt({
      ...base,
      step: { ...implementStep, role: 'review', personaName: 'Reviewer', tools: 'read_only' },
      evidence: builder,
      action: { kind: 'fix', evidenceId: builder.id },
    });
    expect(toReviewer).toContain(
      'The builder sent the work back: Rename the badge prop\nTake it into account, then call mcp__10db__complete_step.',
    );
    expect(toReviewer).not.toContain('commit, and end your turn');
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

  it('asks for a handoff before an account move in its own words, with no commit in a read-only step', () => {
    expect(HANDOFF_NUDGE_ACCOUNT).toMatch(/near its usage limit/);
    expect(HANDOFF_NUDGE_ACCOUNT).toMatch(/starts from your handoff, not this conversation/);
    expect(HANDOFF_NUDGE_ACCOUNT).toMatch(/commit everything/);
    expect(HANDOFF_NUDGE_ACCOUNT).toContain('write_handoff');
    expect(HANDOFF_NUDGE_ACCOUNT_READ_ONLY).toMatch(/near its usage limit/);
    expect(HANDOFF_NUDGE_ACCOUNT_READ_ONLY).not.toMatch(/commit/);
    expect(HANDOFF_FIRM_NUDGE_ACCOUNT).toMatch(/usage limit/);
    expect(HANDOFF_FIRM_NUDGE_ACCOUNT).toContain('write_handoff');
  });

  it('keeps the implement rules for an implement step', () => {
    const prompt = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(prompt).toContain('When the acceptance criteria are met and committed, end your turn.');
    expect(prompt).not.toContain('complete_step');
  });

  it.each([
    ['an implement step', implementStep],
    ['a read-only step', reviewStep],
  ])('asks %s to run project commands in their plain form', (_name, step) => {
    const prompt = buildSessionPrompt({ ...base, step, action: { kind: 'start' } });
    expect(prompt).toContain('Run project commands in their plain form');
    expect(prompt).toContain('no trailing `; echo $?`');
  });

  const SANDBOX_LINES = [
    "Read the repository's agent instructions first: `AGENTS.md`, or `CLAUDE.md` where the repo uses it.",
    'Make temp files with `mktemp "$TMPDIR/x.XXXXXX"`; a bare `mktemp` fails in the sandbox.',
    "A command that fails with `Operation not permitted` hit the sandbox: say which path in your handoff, and don't retry it another way.",
  ];

  it.each([
    ['an implement step', implementStep],
    ['a read-only step', reviewStep],
  ])('tells %s how to work in the lane sandbox when the session is sandboxed', (_name, step) => {
    const prompt = buildSessionPrompt({
      ...base,
      step,
      action: { kind: 'start' },
      sandboxed: true,
    });
    for (const line of SANDBOX_LINES) expect(prompt).toContain(`- ${line}`);
  });

  it.each([
    ['sandboxed: false', { sandboxed: false }],
    ['no sandbox flag', {}],
  ])('says nothing of the sandbox with %s', (_name, flag) => {
    for (const step of [implementStep, reviewStep]) {
      const prompt = buildSessionPrompt({ ...base, step, action: { kind: 'start' }, ...flag });
      expect(prompt).not.toContain('mktemp');
      expect(prompt).not.toContain('Operation not permitted');
      expect(prompt).not.toContain('agent instructions');
    }
  });

  it('tells an implement step to commit every change before it ends its turn', () => {
    const prompt = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(prompt).toContain(
      'Before you end your turn, commit every change in your claims through mcp__10db__commit.',
    );
  });

  it('names the files a step ended with uncommitted, and asks for their commit', () => {
    const prompt = buildSessionPrompt({
      ...base,
      action: { kind: 'uncommitted', paths: ['src/api/a.ts', 'src/api/a.test.ts'] },
    });
    expect(prompt).toContain('- src/api/a.ts\n- src/api/a.test.ts');
    expect(prompt).toContain('Commit each one through mcp__10db__commit');
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

describe('review rounds in a brief', () => {
  const reviewStep = {
    ...implementStep,
    index: 1,
    count: 3,
    role: 'review',
    personaName: 'Reviewer',
    tools: 'read_only',
  } as const;
  const rejection = (summary: string, at: string): StepResult => ({
    summary,
    verdict: 'reject',
    sessionId: mintId('Session'),
    at,
  });
  const brief = (step: Parameters<typeof buildSessionPrompt>[0]['step'], earlier: StepResult[]) =>
    buildSessionPrompt({ ...base, step, earlierResults: earlier, action: { kind: 'start' } });

  it.each(['review', 'qa', 'plan_review'] as const)(
    'tells a %s step on its first round to list every blocking finding in one rejection',
    (role) => {
      const prompt = brief({ ...reviewStep, role }, []);
      expect(prompt).toContain('This is round 1');
      expect(prompt).toContain('every blocking finding');
      expect(prompt).toContain('one rejection');
      expect(prompt).not.toContain('Findings from your earlier rounds');
    },
  );

  it('shows a later round the newest rejection and tells it to check only that, plus what the fix broke', () => {
    const prompt = brief(reviewStep, [
      rejection('1. BLOCKING a.ts:1 stale cache.', '2026-10-13T10:00:00.000Z'),
      rejection('1. BLOCKING b.ts:2 still no test.', '2026-10-13T11:00:00.000Z'),
    ]);
    expect(prompt).toContain('This is round 3');
    expect(prompt).toContain(
      'Findings from your earlier rounds (check only these):\n1. BLOCKING b.ts:2 still no test.',
    );
    // An older round's finding that the newest rejection left out was judged fixed.
    expect(prompt).not.toContain('stale cache');
    expect(prompt).toContain('only whether each earlier finding is fixed');
    expect(prompt).toContain("what the fix's own changes broke");
    expect(prompt).not.toContain('every blocking finding');
  });

  it('says a new finding the fix did not cause is a follow-up, not a rejection', () => {
    const prompt = brief(reviewStep, [
      rejection('1. BLOCKING a.ts:1 stale cache.', '2026-10-13T10:00:00.000Z'),
    ]);
    expect(prompt).toContain('followUps');
    expect(prompt).toContain('does not reject the work');
    // Round 1 may file a real finding that is not blocking too.
    expect(brief(reviewStep, [])).toContain('followUps');
  });

  it('does not count an approval as a rejection round', () => {
    const approved: StepResult = {
      ...rejection('Looks right.', '2026-10-13T10:00:00.000Z'),
      verdict: 'approve',
    };
    expect(brief(reviewStep, [approved])).toContain('This is round 1');
  });

  it('adds nothing to an implement step', () => {
    const prompt = brief(implementStep, []);
    expect(prompt).not.toContain('This is round');
    expect(prompt).not.toContain('followUps');
  });
});

/**
 * Sentences that tell an agent to run the gate. 10db runs the gate after each implement step, so a
 * sentence that says not to, or that 10db runs it, is fine. In a brief, "run it" can only mean the gate.
 * The harness plugin's test holds the same check without that.
 */
function gateInstructions(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?:;])\s+/)
    .filter((s) => !/\bnever\b|\bnot\b|\bdon't\b|10db (already )?r[au]ns?\b/i.test(s))
    .filter((s) =>
      /make gate|GATE PASS|\b(re-?)?run it\b|\b(re-?)?run\b[^.]*\bgate\b|\bexecute\b[^.]*\bgate\b/i.test(
        s,
      ),
    );
}

describe('the gate in a brief', () => {
  // Not `make gate`, so only the brief's own instructions can name it.
  const gateEvidence = (summary: string) => ({
    id: mintId('Evidence'),
    workstreamId: handoff.workstreamId,
    kind: 'gate' as const,
    command: 'scripts/check',
    exitCode: 1,
    summary,
    logPath: null,
    commitShas: [],
    createdAt: '2026-10-13T11:00:00.000Z',
  });
  const reviewStep = { ...implementStep, role: 'review', tools: 'read_only' } as const;
  const failed = gateEvidence('FAILED lint: pnpm lint (log .gate/lint.log)\nGATE FAIL: lint');
  const actions: readonly (readonly [string, NextAction])[] = [
    ['start', { kind: 'start' }],
    ['continue', { kind: 'continue_from_handoff', handoffId: handoff.id }],
    ['resume', { kind: 'resume', providerSessionId: 'p', reason: 'daemon restarted' }],
    ['fresh answer', { kind: 'answer', inboxId: mintId('InboxItem'), providerSessionId: null }],
    ['resumed answer', { kind: 'answer', inboxId: mintId('InboxItem'), providerSessionId: 'p1' }],
    ['fix', { kind: 'fix', evidenceId: failed.id }],
    ['uncommitted', { kind: 'uncommitted', paths: ['src/ui/badge.tsx'] }],
    ['verify', { kind: 'verify' }],
    ['revise', { kind: 'revise', reviewStep: 0 }],
    ['builder review', { kind: 'builder_review', inboxId: mintId('InboxItem') }],
  ];
  const briefs = actions.flatMap(([name, action]) =>
    [implementStep, reviewStep].flatMap((step) =>
      [false, true].flatMap((sandboxed) =>
        [failed, null].map(
          (evidence) =>
            [
              `${name}, ${step.role}${sandboxed ? ', sandboxed' : ''}${evidence ? ', after a failed gate' : ''}`,
              buildSessionPrompt({ ...base, step, sandboxed, evidence, handoff, action }),
            ] as const,
        ),
      ),
    ),
  );

  it.each([
    ['Run make gate before you end your turn.', true],
    ['Done means `make gate` printed `GATE PASS`.', true],
    ['Rerun `make gate` until it passes.', true],
    ['Run the full gate before you end your turn.', true],
    ['The gate failed. Run it, fix the cause, commit, and end your turn.', true],
    ['Execute the gate command before ending your turn.', true],
    ['Never run the full gate: 10db runs it after your turn ends.', false],
    ['Fix the cause, commit, and end your turn; 10db runs the gate again.', false],
  ])('the check reads %j as an instruction to run the gate: %s', (sentence, caught) => {
    expect(gateInstructions(sentence).length > 0).toBe(caught);
  });

  it('briefs a fix from its handoff in one of the rows', () => {
    expect(
      briefs.some(
        ([, brief]) =>
          brief.includes('Continue from the handoff') && brief.includes('The gate failed'),
      ),
    ).toBe(true);
  });

  it.each(briefs)('%s: never tells the agent to run the gate', (_name, brief) => {
    expect(gateInstructions(brief)).toEqual([]);
  });

  it('tells a lane to run only the checks for what it changed', () => {
    const brief = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(brief).toContain('Run only the checks for what you changed');
    expect(brief).toContain('never the full gate');
  });

  it.each([
    [
      'one failing step',
      'FAILED lint: pnpm lint (log .gate/lint.log)\nGATE FAIL: lint — logs in .gate/',
      ['`lint`: rerun `pnpm lint` (log `.gate/lint.log`)'],
    ],
    [
      'two failing steps',
      'FAILED lint: pnpm lint (log .gate/lint.log)\nFAILED test: pnpm test (log .gate/test.log)\nGATE FAIL: lint test',
      ['`lint`: rerun `pnpm lint`', '`test`: rerun `pnpm test` (log `.gate/test.log`)'],
    ],
  ])('names the failing step and its command: %s', (_name, summary, named) => {
    const evidence = gateEvidence(summary);
    const brief = buildSessionPrompt({
      ...base,
      evidence,
      action: { kind: 'fix', evidenceId: evidence.id },
    });
    for (const text of named) expect(brief).toContain(text);
  });

  it('points at the output when it names no failing step', () => {
    const evidence = gateEvidence('FAIL badge.test.ts');
    const brief = buildSessionPrompt({
      ...base,
      evidence,
      action: { kind: 'fix', evidenceId: evidence.id },
    });
    expect(brief).toContain('rerun only the check that failed');
    expect(brief).toContain('FAIL badge.test.ts');
  });
});
