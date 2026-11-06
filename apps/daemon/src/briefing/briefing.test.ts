import type { ContextPack, HandoffDto, NextAction, StepResult } from '@10db/contracts';
import { mintId, Provider } from '@10db/contracts';
import {
  acquireClaims,
  createTestStore,
  insertDecision,
  insertPrinciple,
  insertSource,
  retirePrinciple,
  supersedeDecision,
  withdrawDecision,
  type NewPrinciple,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { readOnlyShellRefusal } from '../guard';
import {
  buildContextPack,
  buildSessionPrompt,
  compactionReinjection,
  denialsForLane,
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
  knowledge: {
    policies: [],
    heuristics: [],
    decisions: [],
    budget: 1500,
    budgetUsed: 0,
    dropped: { policies: 0, heuristics: 0, decisions: 0 },
    droppedCount: 0,
    empty: true,
  },
};
const policyId = mintId('Principle');
const heuristicId = mintId('Principle');
const decisionId = mintId('Decision');
const packWithDecision: ContextPack = {
  ...emptyPack,
  knowledge: {
    ...emptyPack.knowledge,
    policies: [
      {
        kind: 'principle',
        id: policyId,
        statement: 'Never sleep in tests',
        principleKind: 'policy',
        topicKey: 'testing.no-sleeps',
        scope: 'project',
        area: null,
      },
    ],
    heuristics: [
      {
        kind: 'principle',
        id: heuristicId,
        statement: 'Prefer Mantine components',
        principleKind: 'heuristic',
        topicKey: 'ui.mantine',
        scope: 'you',
        area: null,
      },
    ],
    decisions: [
      {
        kind: 'decision',
        id: decisionId,
        question: 'Which badge library?',
        choice: 'Mantine Badge',
        rationale: 'Already in the stack',
        scope: 'area',
        area: 'ui',
      },
    ],
    budgetUsed: 30,
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
  provider: Provider.Claude,
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
  it("carries what the batch's notice says of renumbered migrations, and nothing when none moved", () => {
    const said = '- 0042_x → 0043_x';
    expect(buildSessionPrompt({ ...base, action: { kind: 'start' }, renumbered: said })).toContain(
      said,
    );
    expect(buildSessionPrompt({ ...base, action: { kind: 'start' }, renumbered: null })).toBe(
      buildSessionPrompt({ ...base, action: { kind: 'start' } }),
    );
  });

  it("carries what the batch's notice says of migrations a merge lost, and nothing when none was", () => {
    const said = '- 0042_x (its file is in abc^1)';
    expect(buildSessionPrompt({ ...base, action: { kind: 'start' }, uncarried: said })).toContain(
      said,
    );
    expect(buildSessionPrompt({ ...base, action: { kind: 'start' }, uncarried: null })).toBe(
      buildSessionPrompt({ ...base, action: { kind: 'start' } }),
    );
  });

  it('names the task on its own line, lists criteria and claims, and states the rules', () => {
    const prompt = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(prompt).toContain('Task: Add the badge\n');
    expect(prompt).toContain('- Badge renders');
    expect(prompt).toContain('area ui');
    expect(prompt).toContain('commit tool');
  });

  describe('denials', () => {
    const denials = [
      { toolName: 'Bash', summary: 'yes > /dev/null &', note: 'no CPU load, please' },
      { toolName: 'SandboxNetworkAccess', summary: 'example.com', note: null },
    ];

    it.each<NextAction>([
      { kind: 'start' },
      { kind: 'resume', providerSessionId: 'p-1', reason: 'daemon restart' },
      { kind: 'continue_from_handoff', handoffId: mintId('Handoff') },
    ])('tells every kind of session ($kind) what the builder denied, with the note', (action) => {
      const prompt = buildSessionPrompt({ ...base, action, denials });
      expect(prompt).toContain('The builder denied these calls in this workstream');
      expect(prompt).toContain('Bash: yes > /dev/null &');
      expect(prompt).toContain('Note from the builder: no CPU load, please');
      expect(prompt).toContain('SandboxNetworkAccess: example.com');
      expect(prompt).toMatch(/equivalent/);
    });

    it('says nothing when the builder denied nothing', () => {
      expect(buildSessionPrompt({ ...base, action: { kind: 'start' } })).not.toContain(
        'The builder denied',
      );
      expect(buildSessionPrompt({ ...base, action: { kind: 'start' }, denials: [] })).not.toContain(
        'The builder denied',
      );
    });

    describe('of a path in the worktrees folder', () => {
      const scope = { checkout: '/wt/project/copy', worktreeRoot: '/wt' };
      const denial = (toolName: string, summary: string) => ({ toolName, summary, note: null });

      it.each(['Read', 'Grep', 'Glob', 'LS'])('leaves out a %s outside the copy', (toolName) => {
        expect(denialsForLane([denial(toolName, '/wt/project/src/a.ts')], scope)).toEqual([]);
      });

      it('keeps a read in the copy, a read elsewhere and every other tool', () => {
        const kept = [
          denial('Read', '/wt/project/copy/src/a.ts'),
          denial('Read', '/etc/hosts'),
          denial('Bash', '/wt/project/src/a.ts'),
        ];
        expect(denialsForLane(kept, scope)).toEqual(kept);
      });
    });

    it('repeats them after a compaction', () => {
      const text = compactionReinjection(packWithDecision, denials);
      expect(text).toContain('Bash: yes > /dev/null &');
      expect(text).toContain('no CPU load, please');
      expect(compactionReinjection(packWithDecision)).not.toContain('denied');
    });
  });

  describe('answered cards', () => {
    const inboxId = mintId('InboxItem');
    const answeredCards = [
      {
        id: inboxId,
        kind: 'question',
        question: 'Ship with criterion 1 unmeasured?',
        choice: 'Ship unmeasured',
        note: 'The live run is a follow-up.',
      },
    ] as const;
    const reviewStep = {
      ...implementStep,
      index: 1,
      count: 2,
      role: 'review',
      personaName: 'Reviewer',
      tools: 'read_only',
    } as const;

    it('lists each card answered on the task to a review step, with its id, the question, the choice and the note, and says a covered decision needs no card', () => {
      const prompt = buildSessionPrompt({
        ...base,
        step: reviewStep,
        action: { kind: 'start' },
        answeredCards,
      });
      expect(prompt).toContain('Inbox cards the builder already answered on this task');
      expect(prompt).toContain(inboxId);
      expect(prompt).toContain('Ship with criterion 1 unmeasured?');
      expect(prompt).toContain('Ship unmeasured');
      expect(prompt).toContain('The live run is a follow-up.');
      expect(prompt).toMatch(/do not raise a card/i);
    });

    it('still lets the reviewer raise a card for a decision no answer covers', () => {
      const prompt = buildSessionPrompt({
        ...base,
        step: reviewStep,
        action: { kind: 'start' },
        answeredCards,
      });
      expect(prompt).toMatch(/no answer .*covers/i);
    });

    it('says nothing of answers when the task has none', () => {
      const none = buildSessionPrompt({ ...base, step: reviewStep, action: { kind: 'start' } });
      expect(none).not.toContain('already answered');
      expect(
        buildSessionPrompt({
          ...base,
          step: reviewStep,
          action: { kind: 'start' },
          answeredCards: [],
        }),
      ).toBe(none);
    });

    it('leaves the list out of an implement step', () => {
      expect(
        buildSessionPrompt({ ...base, action: { kind: 'start' }, answeredCards }),
      ).not.toContain('already answered');
    });

    it('repeats the list after a compaction of a review step, as the brief words it', () => {
      const text = compactionReinjection(packWithDecision, [], { role: 'review', answeredCards });
      const brief = buildSessionPrompt({
        ...base,
        step: reviewStep,
        action: { kind: 'start' },
        answeredCards,
      });
      const list = text.slice(text.indexOf('Inbox cards the builder already answered'));
      expect(list).toContain(inboxId);
      expect(list).toContain('Ship with criterion 1 unmeasured?');
      expect(list).toContain('Ship unmeasured');
      expect(list).toContain('The live run is a follow-up.');
      expect(brief).toContain(list);
    });

    it('sits beside the denials after a compaction', () => {
      const denials = [{ toolName: 'Bash', summary: 'pnpm lint', note: null }];
      const text = compactionReinjection(packWithDecision, denials, {
        role: 'review',
        answeredCards,
      });
      expect(text).toContain('Bash: pnpm lint');
      expect(text).toContain(inboxId);
    });

    it('leaves the list out of the compaction of an implement step, and when there is none', () => {
      expect(
        compactionReinjection(packWithDecision, [], { role: 'implement', answeredCards }),
      ).not.toContain('already answered');
      expect(
        compactionReinjection(packWithDecision, [], { role: 'review', answeredCards: [] }),
      ).toBe(compactionReinjection(packWithDecision));
    });
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

  it('renders policies, then heuristics, then decisions, each with its id and scope', () => {
    const prompt = buildSessionPrompt({
      ...base,
      contextPack: packWithDecision,
      action: { kind: 'start' },
    });
    const policy = prompt.indexOf(
      `- [testing.no-sleeps] Never sleep in tests {${policyId}, project}`,
    );
    const heuristic = prompt.indexOf(
      `- [ui.mantine] Prefer Mantine components {${heuristicId}, you}`,
    );
    const decision = prompt.indexOf(
      `- Which badge library? -> Mantine Badge (Already in the stack) {${decisionId}, area:ui}`,
    );
    expect(policy).toBeGreaterThan(prompt.indexOf('Policies (you must follow these'));
    expect(heuristic).toBeGreaterThan(policy);
    expect(decision).toBeGreaterThan(heuristic);
  });

  it('says what each shelf dropped, and never claims nothing applies when the budget hid it', () => {
    const prompt = buildSessionPrompt({
      ...base,
      contextPack: {
        ...emptyPack,
        knowledge: {
          ...emptyPack.knowledge,
          dropped: { policies: 1, heuristics: 0, decisions: 2 },
          droppedCount: 3,
        },
      },
      action: { kind: 'start' },
    });
    expect(prompt).toContain(
      '3 records exceeded the budget (policies: 1, heuristics: 0, decisions: 2)',
    );
    expect(prompt).toContain('find_knowledge');
    expect(prompt).not.toContain('No recorded decisions');
  });

  it('says what was left out beside what fit', () => {
    const prompt = buildSessionPrompt({
      ...base,
      contextPack: {
        ...packWithDecision,
        knowledge: {
          ...packWithDecision.knowledge,
          dropped: { policies: 0, heuristics: 1, decisions: 0 },
          droppedCount: 1,
        },
      },
      action: { kind: 'start' },
    });
    expect(prompt).toContain('Never sleep in tests');
    expect(prompt).toContain(
      '1 records exceeded the budget (policies: 0, heuristics: 1, decisions: 0)',
    );
  });

  it('asks for write_handoff in the nudge and re-injects the rendered pack after compaction', () => {
    expect(HANDOFF_NUDGE).toContain('write_handoff');
    expect(renderHandoff(handoff)).toContain('Next action: Write the render test');
    const text = compactionReinjection({ ...packWithDecision, handoff });
    expect(text).toContain('context pack');
    expect(text).toContain('Task: Add the badge');
    expect(text).toContain(`- [testing.no-sleeps] Never sleep in tests {${policyId}, project}`);
    expect(text).toContain('Mantine Badge');
    expect(text).toContain('Next action: Write the render test');
    expect(text).not.toContain('"knowledge"');
  });

  it('re-injects the same knowledge text the first prompt carried', () => {
    const first = buildSessionPrompt({
      ...base,
      contextPack: packWithDecision,
      action: { kind: 'start' },
    });
    const again = compactionReinjection(packWithDecision);
    const knowledge = [
      'Policies (you must follow these):',
      `- [testing.no-sleeps] Never sleep in tests {${policyId}, project}`,
      'Heuristics (prefer these):',
      `- [ui.mantine] Prefer Mantine components {${heuristicId}, you}`,
      'Recorded decisions:',
      `- Which badge library? -> Mantine Badge (Already in the stack) {${decisionId}, area:ui}`,
    ].join('\n');
    expect(first).toContain(knowledge);
    expect(again).toContain(knowledge);
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
    over: Partial<Parameters<typeof insertDecision>[1]> = {},
  ) =>
    store.write((ctx) =>
      insertDecision(ctx, {
        projectId,
        question,
        choice: 'x'.repeat(300),
        rationale: 'r',
        decidedBy: 'me',
        scope: 'project',
        area: null,
        sourceId: insertSource(ctx, 'builder', {}),
        ...over,
      }),
    ).value;

  const rule = (
    target: NewPrinciple['target'],
    topicKey: string,
    over: Partial<NewPrinciple> = {},
  ) =>
    store.write((ctx) =>
      insertPrinciple(ctx, {
        target,
        statement: `Rule ${topicKey}`,
        kind: 'policy',
        topicKey,
        status: 'confirmed',
        sourceId: insertSource(ctx, 'builder', {}),
        sourceQuote: null,
        speaker: 'me',
        confirmedBy: 'me',
        ...over,
      }),
    ).value;

  const keys = (pack: ContextPack) =>
    [...pack.knowledge.policies, ...pack.knowledge.heuristics].map((p) => p.topicKey);

  it('says so when there is no knowledge', () => {
    const { workstream } = seedWorkstream(store);
    const pack = buildContextPack(store.db, workstream);
    expect(pack.knowledge).toEqual(emptyPack.knowledge);
    expect(pack.task.title).toBe('Alpha');
  });

  it('packs only records that apply to this project and the task’s areas', () => {
    const { project, workstream } = seedWorkstream(store, { areas: ['api'] });
    const other = seedWorkstream(store, { title: 'Other' }).project;
    rule({ scope: 'you' }, 'mine');
    rule({ scope: 'project', projectId: project.id }, 'ours');
    rule({ scope: 'area', projectId: project.id, area: 'api' }, 'api-rule');
    rule({ scope: 'area', projectId: project.id, area: 'ui' }, 'ui-rule');
    rule({ scope: 'project', projectId: other.id }, 'theirs');
    recordDecision(project.id, 'Which icons for the ui?', {
      scope: 'area',
      area: 'ui',
      choice: 'tabler',
    });
    const pack = buildContextPack(store.db, workstream);
    expect(keys(pack)).toEqual(['api-rule', 'ours', 'mine']);
    expect(pack.knowledge.decisions).toEqual([]);
  });

  it('briefs a builder-wide policy in every project', () => {
    const first = seedWorkstream(store, { title: 'First' });
    const second = seedWorkstream(store, { title: 'Second' });
    rule({ scope: 'you' }, 'mine');
    expect(keys(buildContextPack(store.db, first.workstream))).toEqual(['mine']);
    expect(keys(buildContextPack(store.db, second.workstream))).toEqual(['mine']);
  });

  it('widens the areas to a live area claim', () => {
    const { project, workstream } = seedWorkstream(store, { areas: ['api'] });
    rule({ scope: 'area', projectId: project.id, area: 'ui' }, 'ui-rule');
    expect(keys(buildContextPack(store.db, workstream))).toEqual([]);
    store.write((ctx) =>
      acquireClaims(ctx, {
        projectId: project.id,
        workstreamId: workstream.id,
        requests: [{ kind: 'area', name: 'ui' }],
        leaseExpiresAt: ctx.now,
      }),
    );
    expect(keys(buildContextPack(store.db, workstream))).toEqual(['ui-rule']);
  });

  it('packs no superseded, withdrawn, retired or proposed record', () => {
    const { project, workstream } = seedWorkstream(store, { title: 'Alpha queue' });
    const target = { scope: 'project' as const, projectId: project.id };
    rule(target, 'a', { statement: 'Old a' });
    rule(target, 'a', { statement: 'New a' });
    const retired = rule(target, 'b');
    store.write((ctx) => retirePrinciple(ctx, retired.id, 'me', 'old'));
    rule(target, 'c', { status: 'proposed', confirmedBy: null });
    const old = recordDecision(project.id, 'Which queue?', { choice: 'BullMQ' });
    store.write((ctx) =>
      supersedeDecision(ctx, old, {
        projectId: project.id,
        question: 'Which queue?',
        choice: 'pg-boss',
        rationale: 'one database',
        decidedBy: 'me',
        scope: 'project',
        area: null,
        sourceId: insertSource(ctx, 'builder', {}),
      }),
    );
    const gone = recordDecision(project.id, 'Which queue runner?', { choice: 'cron' });
    store.write((ctx) => {
      withdrawDecision(ctx, gone, { by: 'me', reason: 'mistake' });
    });
    const pack = buildContextPack(store.db, workstream);
    expect(pack.knowledge.policies.map((p) => p.statement)).toEqual(['New a']);
    expect(pack.knowledge.decisions.map((d) => d.choice)).toEqual(['pg-boss']);
  });

  it('fills the budget and counts what each shelf dropped', () => {
    const { project, workstream } = seedWorkstream(store, { title: 'Alpha badge' });
    for (let i = 0; i < 5; i += 1) recordDecision(project.id, `Badge question ${String(i)}`);
    rule({ scope: 'project', projectId: project.id }, 'p', { statement: 'y'.repeat(100) });
    const pack = buildContextPack(store.db, workstream, 200);
    expect(pack.knowledge.policies).toHaveLength(1);
    expect(pack.knowledge.decisions.length + pack.knowledge.dropped.decisions).toBe(5);
    expect(pack.knowledge.dropped.decisions).toBeGreaterThan(0);
    expect(pack.knowledge.droppedCount).toBe(pack.knowledge.dropped.decisions);
    expect(pack.knowledge.budget).toBe(200);
    expect(pack.knowledge.budgetUsed).toBeLessThanOrEqual(200);
    expect(pack.knowledge.empty).toBe(false);
  });

  it('packs a decision sharing one word with the task, not a newer one sharing none', () => {
    const { project, workstream } = seedWorkstream(store, {
      title: 'Add retry to the queue worker',
    });
    recordDecision(project.id, 'Which queue library?', { choice: 'BullMQ' });
    recordDecision(project.id, 'Unrelated zebra topic', { choice: 'stripes' });
    const pack = buildContextPack(store.db, workstream);
    expect(pack.knowledge.decisions.map((d) => d.question)).toEqual(['Which queue library?']);
  });

  it('falls back to recent decisions when nothing matches the task', () => {
    const { project, workstream } = seedWorkstream(store, { title: 'Alpha' });
    recordDecision(project.id, 'Unrelated zebra topic', { choice: 'stripes' });
    const pack = buildContextPack(store.db, workstream);
    expect(pack.knowledge.decisions.map((d) => d.question)).toEqual(['Unrelated zebra topic']);
    expect(pack.knowledge.empty).toBe(false);
  });

  it('is deterministic for the same state', () => {
    const { project, workstream } = seedWorkstream(store, { title: 'Alpha badge' });
    for (let i = 0; i < 3; i += 1) recordDecision(project.id, `Badge question ${String(i)}`);
    rule({ scope: 'project', projectId: project.id }, 'p');
    expect(buildContextPack(store.db, workstream, 250)).toEqual(
      buildContextPack(store.db, workstream, 250),
    );
  });

  it('still briefs from policies and the newest decisions when the decision search index is broken', () => {
    const { project, workstream } = seedWorkstream(store, {
      title: 'Alpha queue',
      areas: ['api'],
    });
    rule({ scope: 'project', projectId: project.id }, 'p');
    recordDecision(project.id, 'Which router?', {
      choice: 'hono',
      scope: 'area',
      area: 'api',
    });
    recordDecision(project.id, 'Which queue?', { choice: 'pg-boss' });
    // Defensive mode keeps FTS5 shadow tables read-only; unsafe mode lets the test corrupt one, as an
    // index the startup check could not rebuild would be. Its MATCH now throws SQLITE_CORRUPT_VTAB.
    store.db.$client.unsafeMode(true);
    store.db.$client.exec('DROP TABLE decisions_fts_data; CREATE TABLE decisions_fts_data(x)');
    store.db.$client.unsafeMode(false);
    const pack = buildContextPack(store.db, workstream);
    expect(pack.knowledge.policies.map((p) => p.topicKey)).toEqual(['p']);
    expect(pack.knowledge.decisions.map((d) => d.choice)).toEqual(['hono', 'pg-boss']);
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

  it('asks an implement step to run project commands in their plain form', () => {
    const prompt = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(prompt).toContain('Run project commands in their plain form');
    expect(prompt).toContain('no trailing `; echo $?`');
  });

  it('asks an implement step to run each formatter, linter and test as its own plain command naming its paths', () => {
    const prompt = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(prompt).toContain('formatters, linters and test commands');
    expect(prompt).toContain('its own command');
    expect(prompt).toContain('naming its paths');
    expect(prompt).toContain('pnpm exec prettier --write path/a.ts path/b.ts');
    expect(prompt).toContain('pnpm exec eslint path/a.ts path/b.ts');
  });

  it.each([
    ['an implement step', implementStep],
    ['a read-only step', reviewStep],
  ])('asks %s for commands 10db can store a rule for', (_name, step) => {
    const prompt = buildSessionPrompt({ ...base, step, action: { kind: 'start' } });
    expect(prompt).toContain('no shell variables');
    expect(prompt).toContain('no `cd`');
    expect(prompt).toContain('no pipes through tail or grep');
    expect(prompt).toContain('stops on an "Allow Bash?" card');
  });

  describe('the commands a read-only step is told to run', () => {
    /** Backticked in the rules, but named as things to avoid, or not commands at all. */
    const NOT_EXAMPLES = new Set([
      '; echo $?',
      '$(…)',
      ';',
      '&&',
      'AGENTS.md',
      'CLAUDE.md',
      'Operation not permitted',
    ]);

    const rulesOf = (prompt: string) =>
      prompt.slice(prompt.indexOf('Rules:'), prompt.indexOf('Context pack:'));

    const examplesIn = (prompt: string) =>
      [...rulesOf(prompt).matchAll(/`([^`]+)`/g)]
        .flatMap((match) => match.slice(1))
        .filter((span) => !NOT_EXAMPLES.has(span));

    const readOnlyBriefs = [
      ['a review step', reviewStep, false],
      ['a sandboxed review step', reviewStep, true],
      ['a plan step', { ...reviewStep, role: 'plan' as const }, false],
      ['a sandboxed plan step', { ...reviewStep, role: 'plan' as const }, true],
    ] as const;

    it.each(readOnlyBriefs)('all pass the read-only hook in %s', (_name, step, sandboxed) => {
      const prompt = buildSessionPrompt({ ...base, step, action: { kind: 'start' }, sandboxed });
      const examples = examplesIn(prompt);
      expect(examples.length).toBeGreaterThan(1);
      expect(examples.filter((example) => readOnlyShellRefusal(example) !== null)).toEqual([]);
    });

    it.each(readOnlyBriefs)('name no formatter or pnpm command in %s', (_name, step, sandboxed) => {
      const prompt = rulesOf(
        buildSessionPrompt({ ...base, step, action: { kind: 'start' }, sandboxed }),
      );
      expect(prompt).not.toContain('pnpm exec');
      expect(prompt).not.toContain('prettier');
      expect(prompt).not.toContain('eslint');
      expect(prompt).not.toContain('Run a test');
    });

    it('leave formatting, lint and tests to the gate', () => {
      const prompt = buildSessionPrompt({ ...base, step: reviewStep, action: { kind: 'start' } });
      expect(prompt).toContain('Formatting, lint and tests are left to the gate');
    });
  });

  const SANDBOX_LINES = [
    "Read the repository's agent instructions first: `AGENTS.md`, or `CLAUDE.md` where the repo uses it.",
    "A command that fails with `Operation not permitted` hit the sandbox: say which path in your handoff, and don't retry it another way.",
  ];

  const TEMP_FILES_LINE =
    'Make temp files with `mktemp "$TMPDIR/x.XXXXXX"`; a bare `mktemp` fails in the sandbox.';

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

  it('gives the temp-file line only to a step that can make one', () => {
    const start = { ...base, action: { kind: 'start' as const }, sandboxed: true };
    expect(buildSessionPrompt(start)).toContain(`- ${TEMP_FILES_LINE}`);
    expect(buildSessionPrompt({ ...start, step: reviewStep })).not.toContain('mktemp');
  });

  it.each([
    ['an implement step', implementStep],
    ['a read-only step', reviewStep],
  ])(
    'tells %s what the auto-mode classifier refuses and that a new host is refused',
    (_name, step) => {
      const prompt = buildSessionPrompt({
        ...base,
        step,
        action: { kind: 'start' },
        sandboxed: true,
      });
      expect(prompt).toContain("Claude Code's auto mode refuses");
      expect(prompt).toContain('running the full gate');
      expect(prompt).toContain('CPU load');
      expect(prompt).toContain("outside this lane's worktree");
      expect(prompt).toContain(
        "A command that reaches a network host outside the project's allowed domains is refused",
      );
      expect(prompt).toContain('wait on a card from the builder');
      expect(prompt).toContain('AskUserQuestion');
    },
  );

  it.each([
    ['sandboxed: false', { sandboxed: false }],
    ['no sandbox flag', {}],
  ])('says nothing of the sandbox with %s', (_name, flag) => {
    for (const step of [implementStep, reviewStep]) {
      const prompt = buildSessionPrompt({ ...base, step, action: { kind: 'start' }, ...flag });
      expect(prompt).not.toContain('mktemp');
      expect(prompt).not.toContain('Operation not permitted');
      expect(prompt).not.toContain('agent instructions');
      expect(prompt).not.toContain('auto mode');
    }
  });

  describe('for the agent the session runs on', () => {
    const planningBody = '# Planning\nWrite the plan as numbered steps.';
    const codexInput = {
      ...base,
      provider: Provider.Codex,
      step: { ...implementStep, skills: ['planning'], skillBodies: [planningBody] },
      action: { kind: 'start' as const },
      sandboxed: true,
    };
    const CLAUDE_HOSTS =
      "A command that reaches a network host outside the project's allowed domains is refused, with no prompt. If you need one, ask the builder with AskUserQuestion.";
    const CLAUDE_EDIT =
      'Change files with the Edit or Write tool, never with an interpreter one-liner (`python3 -c`, `node -e`, `perl -pi`, `sed -i`) or shell redirection (`>`, `>>`, a heredoc, `tee`). Edit and Write change the file in your lane without a permission card; a Bash command that writes a file stops on an "Allow Bash?" card and waits for a person, which overnight can be hours. Do a multi-line replacement with one Edit call.';

    it('briefs a Codex lane to change files with apply_patch and to ask through 10db', () => {
      const codex = buildSessionPrompt(codexInput);
      expect(codex).toContain('Change files with apply_patch, never with an interpreter one-liner');
      expect(codex).toContain('In this session, the Edit or Write tool means apply_patch.');
      expect(codex).toContain('mcp__10db__ask_human');
      expect(codex).toContain(
        'The builder adds a host in Settings, which applies from your next session.',
      );
      expect(codex).toContain('fails with its output lost');
      expect(codex).not.toContain('auto mode');
      expect(codex).not.toContain('AskUserQuestion');
      expect(codex).not.toContain('Change files with the Edit or Write tool');
    });

    it('puts a skill’s body under Skills to use for a Codex lane only', () => {
      const codex = buildSessionPrompt(codexInput);
      expect(codex).toContain(planningBody);
      expect(codex.indexOf('Skills to use: planning.')).toBeLessThan(codex.indexOf(planningBody));
      const claude = buildSessionPrompt({ ...codexInput, provider: Provider.Claude });
      expect(claude).toContain('Skills to use: planning.');
      expect(claude).not.toContain(planningBody);
    });

    it('puts the tool-name line after the persona’s instructions', () => {
      const codex = buildSessionPrompt({
        ...codexInput,
        step: { ...codexInput.step, instructions: 'Be brief.' },
      });
      expect(codex.indexOf('How you work:\nBe brief.')).toBeLessThan(
        codex.indexOf('the Edit or Write tool means apply_patch'),
      );
    });

    it.each([
      ['an implement step', implementStep],
      ['a read-only step', reviewStep],
    ])('keeps Claude’s lines for %s unchanged', (_name, step) => {
      const claude = buildSessionPrompt({
        ...base,
        step,
        action: { kind: 'start' },
        sandboxed: true,
      });
      expect(claude).toContain(CLAUDE_HOSTS);
      expect(claude).toContain("Claude Code's auto mode refuses");
      expect(claude).not.toContain('apply_patch');
      expect(claude).not.toContain('fails with its output lost');
    });

    it('keeps the edit rule Claude has always had', () => {
      expect(buildSessionPrompt({ ...base, action: { kind: 'start' } })).toContain(
        `- ${CLAUDE_EDIT}`,
      );
    });

    it('gives a Codex read-only step the sandbox lines without the Claude ones', () => {
      const codex = buildSessionPrompt({
        ...codexInput,
        step: { ...reviewStep, skills: [] },
      });
      expect(codex).toContain('mcp__10db__ask_human');
      expect(codex).toContain('Operation not permitted');
      expect(codex).not.toContain('AskUserQuestion');
      expect(codex).not.toContain('auto mode');
    });
  });

  it('tells an implement step to commit every change before it ends its turn', () => {
    const prompt = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(prompt).toContain(
      'Before you end your turn, commit every change in your claims through mcp__10db__commit.',
    );
  });

  it.each([
    ['an implement step', { ...base, action: { kind: 'start' as const } }],
    [
      'a read-only step',
      {
        ...base,
        step: { ...base.step, role: 'review' as const, tools: 'read_only' as const },
        action: { kind: 'start' as const },
      },
    ],
  ])(
    'tells %s that a background command does not wake it, and to wait in the foreground',
    (_name, input) => {
      const prompt = buildSessionPrompt(input);
      expect(prompt).toContain('A command moved to the background will not wake you by itself');
      expect(prompt).toContain('ending your turn ends the step');
    },
  );

  it('names the files a step ended with uncommitted, and asks for their commit', () => {
    const prompt = buildSessionPrompt({
      ...base,
      action: { kind: 'uncommitted', paths: ['src/api/a.ts', 'src/api/a.test.ts'] },
    });
    expect(prompt).toContain('- src/api/a.ts\n- src/api/a.test.ts');
    expect(prompt).toContain('Commit each one through mcp__10db__commit');
  });

  it('names the files the base merge left conflict markers in, and says to ask the builder about a choice', () => {
    const prompt = buildSessionPrompt({
      ...base,
      action: { kind: 'merge', base: 'origin/main', paths: ['packages/db/src/schema.ts', 'a.md'] },
    });
    expect(prompt).toContain('10db merged origin/main into your branch');
    expect(prompt).toContain('- packages/db/src/schema.ts\n- a.md');
    expect(prompt).toContain('commit each file you changed through mcp__10db__commit');
    expect(prompt).toContain('mcp__10db__request_claim');
    expect(prompt).toContain('Never edit a generated file');
    expect(prompt).toContain('call mcp__10db__ask_human naming the files and why');
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
    ['merge', { kind: 'merge', base: 'origin/main', paths: ['src/ui/badge.tsx'] }],
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

  it('tells an implement step to stop a long design or docs change and file the rest as follow-ups', () => {
    const brief = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(brief).toContain('past about 300 lines');
    expect(brief).toContain('mcp__10db__file_follow_up');
    expect(brief).toContain('Icebox');
  });

  it('tells an implement step to change files with Edit or Write, not an interpreter or a redirect', () => {
    for (const sandboxed of [false, true]) {
      const brief = buildSessionPrompt({ ...base, sandboxed, action: { kind: 'start' } });
      expect(brief).toContain('Change files with the Edit or Write tool');
      expect(brief).toContain('python3 -c');
      expect(brief).toContain('shell redirection');
      expect(brief).toContain('Allow Bash');
    }
  });

  it('does not tell a read-only step to edit files', () => {
    const brief = buildSessionPrompt({ ...base, step: reviewStep, action: { kind: 'start' } });
    expect(brief).not.toContain('Change files with the Edit or Write tool');
  });

  it('tells a plan step to keep a design or docs plan to about one pull request', () => {
    const brief = buildSessionPrompt({
      ...base,
      step: { ...implementStep, role: 'plan', personaName: 'Planner', tools: 'read_only' },
      action: { kind: 'start' },
    });
    expect(brief).toContain('about 300 changed lines');
    expect(brief).toContain('one per decision');
    const review = buildSessionPrompt({
      ...base,
      step: { ...implementStep, role: 'review', personaName: 'Reviewer', tools: 'read_only' },
      action: { kind: 'start' },
    });
    expect(review).not.toContain('about 300 changed lines');
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
