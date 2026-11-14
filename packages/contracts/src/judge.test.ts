import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JUDGE_CONFIG,
  JudgeCallDto,
  JudgeCallsPageQuery,
  JudgeConfig,
  JudgeConfigPatch,
  JudgeTestResultDto,
  mintId,
} from './index';

describe('judge account', () => {
  it('defaults to no account, and a stored config without one reads null', () => {
    expect(DEFAULT_JUDGE_CONFIG.accountId).toBeNull();
    expect(
      JudgeConfig.parse({ enabled: true, decisions: DEFAULT_JUDGE_CONFIG.decisions }).accountId,
    ).toBeNull();
  });

  it('lets a patch set or clear the account', () => {
    const id = mintId('Account');
    expect(JudgeConfigPatch.parse({ accountId: id })).toEqual({ accountId: id });
    expect(JudgeConfigPatch.parse({ accountId: null })).toEqual({ accountId: null });
    expect(() => JudgeConfigPatch.parse({ accountId: 'nope' })).toThrow();
  });
});

describe('judge config', () => {
  it('has the defaults the design names', () => {
    expect(DEFAULT_JUDGE_CONFIG).toEqual({
      enabled: true,
      accountId: null,
      decisions: {
        review_size: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.8 },
        shape_ready: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.8 },
        shape_record: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.8 },
        shape_elsewhere: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.8 },
        question_route: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.8 },
        thread_answer: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.8 },
        reply_match: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.8 },
        approval_read: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.8 },
        task_rigor: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.8 },
        task_kinds: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.8 },
      },
    });
    expect(JudgeConfig.parse(DEFAULT_JUDGE_CONFIG)).toEqual(DEFAULT_JUDGE_CONFIG);
  });

  it('reads a config stored before the Shape decisions with their defaults, keeping its own', () => {
    const stored = {
      enabled: false,
      decisions: { review_size: { enabled: false, model: 'm', floor: 0.5 } },
    };
    const config = JudgeConfig.parse(stored);
    expect(config.enabled).toBe(false);
    expect(config.decisions.review_size).toEqual({ enabled: false, model: 'm', floor: 0.5 });
    expect(config.decisions.shape_record).toEqual(DEFAULT_JUDGE_CONFIG.decisions.shape_record);
  });

  it.each([
    'question_route',
    'thread_answer',
    'reply_match',
    'approval_read',
    'task_rigor',
    'task_kinds',
  ] as const)('reads a config stored before %s with its default', (decision) => {
    const config = JudgeConfig.parse({
      enabled: true,
      decisions: { review_size: { enabled: true, model: 'm', floor: 0.5 } },
    });
    expect(config.decisions[decision]).toEqual(DEFAULT_JUDGE_CONFIG.decisions[decision]);
  });

  it.each([
    ['above one', 1.01],
    ['below zero', -0.1],
    ['not a number', Number.NaN],
  ])('rejects a floor %s', (_name, floor) => {
    const config = {
      enabled: true,
      decisions: { review_size: { enabled: true, model: 'm', floor } },
    };
    expect(JudgeConfig.safeParse(config).success).toBe(false);
  });

  it('rejects an empty model', () => {
    const config = {
      enabled: true,
      decisions: { review_size: { enabled: true, model: '', floor: 0.5 } },
    };
    expect(JudgeConfig.safeParse(config).success).toBe(false);
  });
});

describe('judge config patch', () => {
  it.each([
    ['empty', {}],
    ['the master switch', { enabled: false }],
    ['one decision field', { decisions: { review_size: { floor: 0.9 } } }],
    ['an empty decision', { decisions: { review_size: {} } }],
    ['question_route', { decisions: { question_route: { floor: 0.9 } } }],
    ['thread_answer', { decisions: { thread_answer: { enabled: false } } }],
    ['reply_match', { decisions: { reply_match: { floor: 0.9 } } }],
    ['approval_read', { decisions: { approval_read: { enabled: false } } }],
  ])('accepts %s', (_name, patch) => {
    expect(JudgeConfigPatch.safeParse(patch).success).toBe(true);
  });

  it.each([
    ['a floor above one', { decisions: { review_size: { floor: 2 } } }],
    ['an unknown decision', { decisions: { mystery: { enabled: true } } }],
    ['an unknown field', { enabled: true, extra: 1 }],
  ])('rejects %s', (_name, patch) => {
    expect(JudgeConfigPatch.safeParse(patch).success).toBe(false);
  });
});

describe('judge results', () => {
  it('parses a test result either way', () => {
    expect(
      JudgeTestResultDto.parse({ ok: true, model: 'm', latencyMs: 120, costUsd: null }).ok,
    ).toBe(true);
    expect(JudgeTestResultDto.parse({ ok: false, error: 'no key' }).ok).toBe(false);
    expect(JudgeTestResultDto.safeParse({ ok: true, model: 'm' }).success).toBe(false);
  });

  it('parses a logged call', () => {
    const call = {
      id: mintId('JudgeCall'),
      decision: 'review_size',
      model: 'typesafe/jev-1.13',
      question: 'q',
      answer: 'skip',
      confidence: 0.91,
      outcome: 'acted',
      latencyMs: 300,
      costUsd: 0.0002,
      workstreamId: mintId('Workstream'),
      taskId: mintId('Task'),
      createdAt: '2026-10-31T10:00:00.000Z',
    };
    expect(JudgeCallDto.parse(call)).toEqual(call);
    expect(JudgeCallDto.safeParse({ ...call, outcome: 'maybe' }).success).toBe(false);
  });
});

describe('judge calls page query', () => {
  it.each([
    ['nothing', {}, { limit: 20, offset: 0 }],
    ['a limit over 100', { limit: '500' }, { limit: 100, offset: 0 }],
    ['a limit that is not a number', { limit: 'lots' }, { limit: 20, offset: 0 }],
    [
      'an offset and a decision',
      { offset: '40', decision: 'review_size' },
      {
        limit: 20,
        offset: 40,
        decision: 'review_size',
      },
    ],
  ])('reads %s', (_name, input, expected) => {
    expect(JudgeCallsPageQuery.parse(input)).toEqual(expected);
  });

  it.each([
    ['an unknown decision', { decision: 'nope' }],
    ['an unknown outcome', { outcome: 'nope' }],
    ['a negative offset', { offset: '-1' }],
  ])('rejects %s', (_name, input) => {
    expect(JudgeCallsPageQuery.safeParse(input).success).toBe(false);
  });
});
