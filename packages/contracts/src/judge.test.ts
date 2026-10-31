import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JUDGE_CONFIG,
  JudgeCallDto,
  JudgeConfig,
  JudgeConfigPatch,
  JudgeKeyInput,
  JudgeTestResultDto,
  mintId,
} from './index';

describe('judge config', () => {
  it('has the defaults the design names', () => {
    expect(DEFAULT_JUDGE_CONFIG).toEqual({
      enabled: true,
      decisions: {
        review_size: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.8 },
      },
    });
    expect(JudgeConfig.parse(DEFAULT_JUDGE_CONFIG)).toEqual(DEFAULT_JUDGE_CONFIG);
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

describe('judge key input', () => {
  it('trims the key', () => {
    expect(JudgeKeyInput.parse({ key: '  sk-or-v1-abc  ' })).toEqual({ key: 'sk-or-v1-abc' });
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['holding a space', 'sk or'],
    ['holding a quote', 'sk"or'],
  ])('rejects a key that is %s', (_name, key) => {
    expect(JudgeKeyInput.safeParse({ key }).success).toBe(false);
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
