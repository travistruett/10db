import {
  JudgeDecision,
  JudgeOutcome,
  type DecisionModelDto,
  type DecisionStatsDto,
  type DecisionStatsListDto,
  type ShadowAgreementDto,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { DecisionMode } from './decision-catalogue';
import {
  answerText,
  decisionStatus,
  formatDecisionUsd,
  lastThirtyDays,
  modelName,
  outcomeText,
  previewText,
  statsFor,
  thresholdPreview,
} from './decision-numbers';

const stats = (over: Partial<DecisionStatsDto> = {}): DecisionStatsDto => ({
  decision: JudgeDecision.ReviewSize,
  calls: 0,
  acted: 0,
  belowFloor: 0,
  shadow: 0,
  stopped: 0,
  fallbacks: { off: 0, no_key: 0, timeout: 0, error: 0 },
  costUsd: 0,
  medianLatencyMs: null,
  answers: [],
  ...over,
});

const agreement = (over: Partial<ShadowAgreementDto>): ShadowAgreementDto => ({
  decision: JudgeDecision.ShapeReady,
  answered: 0,
  scored: 0,
  agreed: 0,
  canShow: false,
  ...over,
});

describe('decisionStatus', () => {
  it.each([
    ['all off, acting', DecisionMode.Acting, true, false, 'Off (all decisions)'],
    ['all off, shadow', DecisionMode.Shadow, true, false, 'Off (all decisions)'],
    ['all off, decision off', DecisionMode.Acting, false, false, 'Off (all decisions)'],
    ['decision off', DecisionMode.Acting, false, true, 'Off'],
    ['acting', DecisionMode.Acting, true, true, 'Acting'],
    ['shadow', DecisionMode.Shadow, true, true, 'Shadow'],
  ] as const)('%s', (_name, mode, decisionOn, allOn, expected) => {
    expect(decisionStatus(mode, decisionOn, allOn)).toBe(expected);
  });
});

describe('statsFor', () => {
  const entry = stats({ decision: JudgeDecision.QuestionRoute, calls: 4 });
  const list: DecisionStatsListDto = { since: '2026-11-01T00:00:00.000Z', decisions: [entry] };
  it.each([
    ['unread', undefined, JudgeDecision.QuestionRoute, undefined],
    ['loaded without the decision', list, JudgeDecision.ReviewSize, stats()],
    ['loaded with it', list, JudgeDecision.QuestionRoute, entry],
  ] as const)('%s', (_name, given, decision, expected) => {
    expect(statsFor(given, decision)).toEqual(expected);
  });
});

describe('lastThirtyDays', () => {
  it.each([
    ['unread', undefined, DecisionMode.Acting, undefined, '—'],
    ['no calls', stats(), DecisionMode.Acting, undefined, 'No calls'],
    ['shadow, no calls, no agreement', stats(), DecisionMode.Shadow, undefined, 'No calls · —'],
    [
      'shadow, calls, agreement unread',
      stats({ calls: 14 }),
      DecisionMode.Shadow,
      undefined,
      '14 calls · —',
    ],
    [
      'acting',
      stats({ calls: 120, acted: 62, costUsd: 0.0123 }),
      DecisionMode.Acting,
      undefined,
      '120 calls · 62 acted · $0.0123',
    ],
    [
      'one call',
      stats({ calls: 1, acted: 1, costUsd: 0.5 }),
      DecisionMode.Acting,
      undefined,
      '1 call · 1 acted · $0.5',
    ],
    [
      'shadow, few scored',
      stats({ calls: 14 }),
      DecisionMode.Shadow,
      agreement({ scored: 3 }),
      '14 calls · 3 of 20 scored',
    ],
    [
      'shadow, enough scored',
      stats({ calls: 24 }),
      DecisionMode.Shadow,
      agreement({ scored: 24, agreed: 18 }),
      '24 calls · 18 of 24 agreed',
    ],
  ] as const)('%s', (_name, given, mode, agree, expected) => {
    expect(lastThirtyDays(given, mode, agree)).toBe(expected);
  });
});

describe('thresholdPreview', () => {
  const on = (model: string, ...confidences: number[]) =>
    confidences.map((confidence) => ({ model, confidence }));
  it.each([
    [
      'an answer equal to the floor acts',
      on('m', 0.5, 0.8, 0.95),
      { acted: 2, total: 3, otherModels: [] },
    ],
    [
      'other models are named once',
      [...on('old', 0.9, 0.9), ...on('m', 0.9)],
      { acted: 3, total: 3, otherModels: ['old'] },
    ],
  ])('%s', (_name, answers, expected) => {
    expect(thresholdPreview(answers, 0.8, 'm')).toEqual(expected);
  });
});

describe('previewText', () => {
  it.each([
    [
      'counts',
      80,
      { acted: 62, total: 120, otherModels: [] },
      'At 80%, 10db would have acted on 62 of your last 120 answers.',
    ],
    [
      'no answers',
      80,
      { acted: 0, total: 0, otherModels: [] },
      'No answers in the last 30 days to try it against.',
    ],
    [
      'another model',
      80,
      { acted: 62, total: 120, otherModels: ['old'] },
      'At 80%, 10db would have acted on 62 of your last 120 answers. Some were answered by old, not the model picked now.',
    ],
  ])('%s', (_name, percent, preview, expected) => {
    expect(previewText(percent, preview)).toBe(expected);
  });

  it('says would have counted as sure for a shadow decision, which acts on nothing', () => {
    expect(previewText(80, { acted: 62, total: 120, otherModels: [] }, DecisionMode.Shadow)).toBe(
      'At 80%, 10db would have counted as sure 62 of your last 120 answers.',
    );
  });
});

describe('outcomeText', () => {
  it.each([
    ['skip', JudgeDecision.ReviewSize, JudgeOutcome.Acted, 'skip', 'Skipped the review'],
    ['review', JudgeDecision.ReviewSize, JudgeOutcome.Acted, 'review', 'Ran the review'],
    [
      'route acted',
      JudgeDecision.QuestionRoute,
      JudgeOutcome.Acted,
      'billing',
      'Followed the answer',
    ],
    [
      'timeout',
      JudgeDecision.QuestionRoute,
      JudgeOutcome.FallbackTimeout,
      null,
      'Timed out; you answer it',
    ],
    [
      'below floor',
      JudgeDecision.ReplyMatch,
      JudgeOutcome.BelowFloor,
      '2',
      'Not sure enough; 10db asked which one',
    ],
    [
      'no key',
      JudgeDecision.ReviewSize,
      JudgeOutcome.FallbackNoKey,
      null,
      'No key; the review ran',
    ],
    [
      'off',
      JudgeDecision.ApprovalRead,
      JudgeOutcome.FallbackOff,
      null,
      'Decisions were off; read with the word list',
    ],
    [
      'error',
      JudgeDecision.ThreadAnswer,
      JudgeOutcome.FallbackError,
      null,
      'The call failed; 10db asked which way',
    ],
    ['stopped', JudgeDecision.ReviewSize, JudgeOutcome.Stopped, null, 'Stopped before it answered'],
    [
      'shadow',
      JudgeDecision.ShapeReady,
      JudgeOutcome.Shadow,
      'yes',
      'Logged in shadow; nothing shown',
    ],
  ] as const)('%s', (_name, decision, outcome, answer, expected) => {
    expect(outcomeText({ decision, outcome, answer })).toBe(expected);
  });
});

describe('answerText', () => {
  it.each([
    ['with confidence', 'skip', 0.92, 'skip (92%)'],
    ['no confidence', 'skip', null, 'skip'],
    ['no answer', null, 0.9, 'no answer'],
  ])('%s', (_name, answer, confidence, expected) => {
    expect(answerText({ answer, confidence })).toBe(expected);
  });
});

describe('formatDecisionUsd', () => {
  it.each([
    [0.0123, '$0.0123'],
    [0, '$0'],
    [1.23456, '$1.23'],
    [9e-7, '$0.0000009'],
    [4.2e-8, '$0.000000042'],
  ])('%s', (usd, expected) => {
    expect(formatDecisionUsd(usd)).toBe(expected);
  });
});

describe('modelName', () => {
  const models: DecisionModelDto[] = [
    {
      id: 'typesafe/jev-1.13',
      name: 'Jev 1.13',
      maker: 'TypeSafe',
      latest: false,
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      cantCall: null,
      costPerMillionUsd: null,
      secondsPerDecision: null,
      costSource: null,
      timeSource: null,
    },
  ];
  it.each([
    ['listed', 'typesafe/jev-1.13', models, 'Jev 1.13'],
    ['list unread', 'typesafe/jev-1.13', undefined, 'jev-1.13'],
    ['not in the list', 'x/other', models, 'other'],
  ])('%s', (_name, id, list, expected) => {
    expect(modelName(id, list)).toBe(expected);
  });
});
