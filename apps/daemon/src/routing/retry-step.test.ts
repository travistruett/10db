import { mintId, type PatternDto, type WorkstreamStep } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { retryStep } from './retry-step';
import { label, testCatalogue } from './test-catalogue';

const PROJECT = mintId('Project');
const profiles = testCatalogue();
const at = (name: string) => {
  const p = profiles.find((x) => label(x) === name);
  if (!p) throw new Error(name);
  return p;
};
const stepOn = (name: string, extra: Partial<WorkstreamStep> = {}): WorkstreamStep => {
  const p = at(name);
  return {
    role: 'implement',
    personaId: null,
    personaName: 'Implementer',
    tools: 'edit',
    profileId: p.id,
    model: p.model,
    effort: p.effort,
    need: 40,
    reason: 'by score',
    overBudget: false,
    pinned: false,
    status: 'running',
    attempts: 1,
    startedAt: null,
    sessionFloor: 0,
    result: null,
    earlier: [],
    sentBack: 0,
    setting: { kind: 'automatic' },
    ...extra,
  };
};
const retryPattern = (model: string): PatternDto => ({
  id: mintId('Pattern'),
  projectId: null,
  name: 'On a retry',
  match: { roles: [], riskTags: [], areas: [], retryOnly: true },
  setting: { kind: 'model', model },
  position: 0,
});
const input = (patterns: PatternDto[]) => ({
  choose: {
    def: { role: 'implement', need: 40 } as const,
    persona: undefined,
    task: { riskTags: [], acceptanceCriteria: [], areas: [], modelSetting: null },
    project: { id: PROJECT, budgetCeiling: null },
    profiles,
    roleSettings: [],
    patterns,
    tierOverrides: {},
  },
  escalate: { budgetCeiling: null, profiles, why: 'the gate failed' },
});
const ran = (result: ReturnType<typeof retryStep>) => `${result.step.model}@${result.step.effort}`;

describe('retryStep', () => {
  it('moves a step to the model a retry-only pattern names, and says so', () => {
    const result = retryStep(stepOn('mid@high'), input([retryPattern('big')]));
    expect(ran(result)).toBe('big@high');
    expect(result.escalated).toBe(true);
    expect(result.step.setting).toEqual({ kind: 'model', model: 'big' });
    expect(result.step.reason).toContain('escalated from mid@high after the gate failed');
    expect(result.step.reason).toContain('the pattern "On a retry"');
  });

  it('climbs one rung when the step already runs where the retry pattern sends it', () => {
    const result = retryStep(
      stepOn('big@high', { setting: { kind: 'model', model: 'big' } }),
      input([retryPattern('big')]),
    );
    expect(ran(result)).toBe('big@max');
    expect(result.escalated).toBe(true);
  });

  it('climbs one rung when no pattern is about a retry', () => {
    const result = retryStep(stepOn('mid@high'), input([]));
    expect(ran(result)).toBe('big@high');
    expect(result.step.reason).toBe('escalated from mid@high after the gate failed');
  });

  it('keeps a pinned step where it is', () => {
    const result = retryStep(stepOn('mid@high', { pinned: true }), input([retryPattern('big')]));
    expect(ran(result)).toBe('mid@high');
    expect(result.escalated).toBe(false);
  });

  it('ignores a retry pattern naming a model the account lacks', () => {
    const result = retryStep(stepOn('mid@high'), input([retryPattern('ghost')]));
    expect(result.step.reason).toBe('escalated from mid@high after the gate failed');
  });
});

describe('retryStep when no profile reaches the need', () => {
  it('climbs a rung instead of throwing, with every scored profile below the need', () => {
    const result = retryStep(stepOn('mid@high', { need: 99 }), {
      ...input([]),
      choose: { ...input([]).choose, def: { role: 'implement', need: 99 } },
    });
    expect(ran(result)).toBe('big@high');
    expect(result.escalated).toBe(true);
  });
});
