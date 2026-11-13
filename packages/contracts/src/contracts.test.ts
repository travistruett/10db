import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ContextPack,
  HealthResponse,
  InboxAnswer,
  InboxItemDto,
  McpToolOutputs,
  McpToolInputs,
  mintId,
  PersonDto,
  PersonInput,
  DECISION_CATEGORIES,
  PROTOCOL_VERSION,
  QUESTION_CATEGORY_HINTS,
  QuestionCategory,
  RecordedAnswer,
  renderJsonSchemas,
  RoutingRulesInput,
  SlackConnectionDto,
  SlackContactDto,
  StakeholderTimersDto,
} from './index';

const person = mintId('Person');
const other = mintId('Person');
const goal = mintId('Goal');
const task = mintId('Task');
const rule = (over: Record<string, unknown>) => ({
  category: 'product',
  area: null,
  personId: person,
  ...over,
});

describe('McpToolOutputs.propose', () => {
  it('still parses a result recorded before either id existed', () => {
    const proposalId = mintId('Proposal');
    expect(McpToolOutputs.propose.parse({ proposalId })).toEqual({
      proposalId,
      taskId: null,
      principleId: null,
    });
  });
});

describe('HealthResponse', () => {
  it('accepts a well-formed health payload', () => {
    const payload = {
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      startedAt: '2026-10-13T12:00:00.000Z',
    };
    expect(HealthResponse.parse(payload)).toEqual({ ...payload, commit: null, devUiOrigin: null });
  });

  it.each([
    [
      'wrong status',
      { status: 'degraded', protocolVersion: 1, startedAt: '2026-10-13T12:00:00.000Z' },
    ],
    [
      'non-integer protocol',
      { status: 'ok', protocolVersion: 1.5, startedAt: '2026-10-13T12:00:00.000Z' },
    ],
    ['non-ISO start time', { status: 'ok', protocolVersion: 1, startedAt: 'yesterday' }],
  ])('rejects %s', (_name, payload) => {
    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });
});

describe('PROTOCOL_VERSION', () => {
  it('is 9: the model tiers became four rungs', () => {
    expect(PROTOCOL_VERSION).toBe(9);
  });
});

describe('generated JSON Schema', () => {
  it('matches the committed files byte for byte', () => {
    for (const [file, text] of renderJsonSchemas()) {
      const committed = readFileSync(resolve(import.meta.dirname, '../generated', file), 'utf8');
      expect(committed, `${file} is stale; run pnpm --filter @10db/contracts generate`).toBe(text);
    }
  });
});

describe('RoutingRulesInput', () => {
  it.each([
    ['both a goal and a task', rule({ goalId: goal, taskId: task })],
    ['a task and an area', rule({ taskId: task, area: 'web' })],
    ['a category and a topic', rule({ topic: 'billing' })],
    ['neither a category nor a topic', rule({ category: null })],
    ['a topic with a goal', rule({ category: null, topic: 'billing', goalId: goal })],
    ['a topic with a task', rule({ category: null, topic: 'billing', taskId: task })],
    ['a topic with an area', rule({ category: null, topic: 'billing', area: 'web' })],
    ['a topic over 120 characters', rule({ category: null, topic: 'x'.repeat(121) })],
  ])('refuses %s', (_name, row) => {
    expect(RoutingRulesInput.safeParse({ rules: [row] }).success).toBe(false);
  });

  it('refuses two identical rows', () => {
    expect(RoutingRulesInput.safeParse({ rules: [rule({}), rule({})] }).success).toBe(false);
  });

  it.each([
    ['one category at project and goal scope', [rule({}), rule({ goalId: goal })]],
    ['one category at one scope for two people (a tie)', [rule({}), rule({ personId: other })]],
    ['a topic route', [rule({ category: null, topic: 'billing' })]],
  ])('accepts %s', (_name, rules) => {
    expect(RoutingRulesInput.safeParse({ rules }).success).toBe(true);
  });

  it('defaults the new scope fields to null', () => {
    const parsed = RoutingRulesInput.parse({
      rules: [{ category: 'design', area: null, personId: person }],
    });
    expect(parsed.rules[0]).toMatchObject({ goalId: null, taskId: null, topic: null });
  });
});

describe('answers', () => {
  it('drops answeredBy from the HTTP answer body', () => {
    expect(InboxAnswer.parse({ choice: 'B', answeredBy: 'mark' })).toEqual({ choice: 'B' });
  });

  it('keeps who answered on the recorded answer', () => {
    expect(
      RecordedAnswer.parse({ choice: 'B', answeredBy: 'mark', via: 'slack', with: ['ana'] }),
    ).toMatchObject({ answeredBy: 'mark', via: 'slack', with: ['ana'] });
    expect(RecordedAnswer.safeParse({ choice: 'B', via: 'sms' }).success).toBe(false);
  });
});

describe('older payloads', () => {
  const card = {
    id: mintId('InboxItem'),
    projectId: mintId('Project'),
    kind: 'question',
    state: 'OPEN',
    title: 't',
    body: 'b',
    options: [],
    recommendation: null,
    category: 'product',
    urgency: 'normal',
    assignee: 'mark',
    detail: null,
    answer: null,
    targets: [],
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
  };

  it('parses an inbox card without send, assignees, routedBy or routeSuggestion', () => {
    expect(InboxItemDto.parse(card)).toMatchObject({
      send: null,
      assignees: ['mark'],
      routedBy: 'rule',
      routeSuggestion: null,
    });
  });

  it('parses a person without a slack contact, and an input without one', () => {
    const dto = {
      id: person,
      handle: 'mark',
      name: 'Mark',
      isBuilder: false,
      createdAt: '2026-11-12T10:00:00.000Z',
      updatedAt: '2026-11-12T10:00:00.000Z',
    };
    expect(PersonDto.parse(dto).slack).toBeNull();
    expect(PersonInput.parse({ handle: 'mark', name: 'Mark' }).slack).toBeNull();
  });

  it('parses a pending answer written before the conversation fields', () => {
    const pack = ContextPack.shape.pendingAnswer.parse({ question: 'q', answer: 'a', note: null });
    expect(pack).toMatchObject({ answeredBy: null, via: 'inbox', words: null, conversation: [] });
  });

  it('parses ask_human with and without a topic', () => {
    const base = {
      opId: 'op-12345678',
      category: 'product',
      question: 'q',
      options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
    };
    expect(McpToolInputs.ask_human.safeParse(base).success).toBe(true);
    expect(McpToolInputs.ask_human.safeParse({ ...base, topic: 'billing' }).success).toBe(true);
    expect(McpToolInputs.ask_human.safeParse({ ...base, topic: 'x'.repeat(121) }).success).toBe(
      false,
    );
  });
});

describe('slack contacts and timers', () => {
  const contact = { teamId: 'T1', userId: 'U1', dmChannelId: null, sendMode: 'review' };

  it('defaults the daily limit to 10, takes null as off, and refuses 0', () => {
    expect(SlackContactDto.parse(contact).dailyLimit).toBe(10);
    expect(SlackContactDto.parse({ ...contact, dailyLimit: null }).dailyLimit).toBeNull();
    expect(SlackContactDto.safeParse({ ...contact, dailyLimit: 0 }).success).toBe(false);
    expect(SlackContactDto.safeParse({ ...contact, dailyLimit: 101 }).success).toBe(false);
  });

  it('defaults the timers to 4 and 8 hours', () => {
    expect(StakeholderTimersDto.parse({})).toEqual({ remindAfterHours: 4, returnAfterHours: 8 });
    expect(StakeholderTimersDto.parse({ remindAfterHours: null })).toMatchObject({
      remindAfterHours: null,
    });
  });

  it.each([
    ['a reminder equal to the return', { remindAfterHours: 8, returnAfterHours: 8 }],
    ['a reminder after the return', { remindAfterHours: 9, returnAfterHours: 8 }],
    ['a reminder of 0', { remindAfterHours: 0 }],
    ['a return over a week', { returnAfterHours: 169 }],
  ])('refuses %s', (_name, timers) => {
    expect(StakeholderTimersDto.safeParse(timers).success).toBe(false);
  });

  it('accepts a connection that is unreachable', () => {
    const connection = {
      state: 'unreachable',
      teamId: null,
      teamName: null,
      botUserId: null,
      checkedAt: null,
      error: 'offline',
    };
    expect(SlackConnectionDto.safeParse(connection).success).toBe(true);
  });
});

describe('question categories', () => {
  it('are the six, each with a hint and what it covers', () => {
    expect(Object.values(QuestionCategory).sort()).toEqual([
      'access',
      'business',
      'design',
      'engineering',
      'other',
      'product',
    ]);
    for (const category of Object.values(QuestionCategory)) {
      expect(QUESTION_CATEGORY_HINTS[category].hint.length).toBeGreaterThan(0);
      expect(QUESTION_CATEGORY_HINTS[category].covers.length).toBeGreaterThan(0);
    }
  });

  it('record a decision for product, business, design and engineering only', () => {
    expect([...DECISION_CATEGORIES].sort()).toEqual([
      'business',
      'design',
      'engineering',
      'product',
    ]);
  });

  it.each([
    ['business', true],
    ['access', true],
    ['environment', false],
  ])('ask_human takes %s: %s', (category, ok) => {
    const input = {
      opId: 'op-12345678',
      category,
      question: 'q',
      options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
    };
    expect(McpToolInputs.ask_human.safeParse(input).success).toBe(ok);
  });
});
