import type { ContextPack } from '@10db/contracts';
import { Provider } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { buildSessionPrompt } from './index';

const task = {
  title: 'Add the badge',
  description: 'A status badge.',
  acceptanceCriteria: ['Badge renders', 'Has a test'],
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
  plan: null,
  mockups: [],
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

// T4 call 21: a lane nobody watches is told its questions are answered at once; a pass keeps asking.
describe('a question in a task nobody watches', () => {
  const ASK_LINE =
    'When a decision is not yours to make, ask with ask_human (or your question tool).';
  const AWAY_LINE =
    'Nobody is watching this task: a question gets "The builder is away. Make the call yourself and say in your handoff what you decided and why." at once. Decide yourself, and say in your handoff what you decided and why.';

  it('an unattended lane is told questions are answered at once', () => {
    const prompt = buildSessionPrompt({ ...base, action: { kind: 'start' }, attended: false });
    expect(prompt).toContain(AWAY_LINE);
    expect(prompt).not.toContain(ASK_LINE);
  });
});
