import { describe, expect, it } from 'vitest';
import { InboxAnswer } from './entities';
import { EventType } from './events';
import { PrincipleId, mintId } from './ids';
import {
  DecisionInput,
  KnowledgeTarget,
  PrincipleDraft,
  targetColumns,
  TOPIC_KEY_MAX,
  TopicKey,
  topicKeyFrom,
} from './knowledge';
import { CONTRACT_SCHEMAS } from './json-schema';
import { RecordScope } from './shape';
import {
  KnowledgeScope,
  KnowledgeState,
  PrincipleKind,
  PrincipleReviewChoice,
  PrincipleStatus,
  PrincipleVerdict,
  ProposalStatus,
} from './states';

const projectId = mintId('Project');

describe('the knowledge vocabularies', () => {
  it('keeps one scope vocabulary, shared with Shape records', () => {
    expect(RecordScope).toBe(KnowledgeScope);
    expect(Object.values(KnowledgeScope)).toEqual(['you', 'project', 'area']);
  });

  it.each([
    {
      name: 'principle kinds',
      vocabulary: PrincipleKind,
      values: ['policy', 'heuristic', 'belief'],
    },
    {
      name: 'principle statuses',
      vocabulary: PrincipleStatus,
      values: ['proposed', 'confirmed', 'retired'],
    },
    {
      name: 'derived states',
      vocabulary: KnowledgeState,
      values: ['proposed', 'current', 'superseded', 'retired', 'withdrawn'],
    },
    {
      name: 'proposal statuses',
      vocabulary: ProposalStatus,
      values: ['pending', 'accepted', 'rejected'],
    },
    {
      name: 'principle verdicts',
      vocabulary: PrincipleVerdict,
      values: ['accept_project', 'accept_you', 'accept_area', 'reject'],
    },
    { name: 'review choices', vocabulary: PrincipleReviewChoice, values: ['keep', 'retire'] },
  ])('lists the $name', ({ vocabulary, values }) => {
    expect(Object.values(vocabulary)).toEqual(values);
  });
});

describe('principle ids and events', () => {
  it('mints a pri_ id that PrincipleId parses, and refuses another kind', () => {
    const id = mintId('Principle');
    expect(id.startsWith('pri_')).toBe(true);
    expect(PrincipleId.safeParse(id).success).toBe(true);
    expect(PrincipleId.safeParse(mintId('Decision')).success).toBe(false);
  });

  it('adds principle.saved and context.packed, and keeps decision.withdrawn', () => {
    expect(EventType.PrincipleSaved).toBe('principle.saved');
    expect(EventType.ContextPacked).toBe('context.packed');
    expect(EventType.DecisionWithdrawn).toBe('decision.withdrawn');
    expect(Object.values(EventType)).not.toContain('decision.changed');
  });
});

describe('the knowledge schemas are registered for JSON Schema generation', () => {
  it.each([
    'decision-input',
    'decision-dto',
    'principle-draft',
    'principle-input',
    'principle-dto',
    'reason-input',
    'proposal-dto',
    'proposal-accept',
    'proposal-reject',
    'provenance-dto',
  ])('%s', (name) => {
    expect(CONTRACT_SCHEMAS).toHaveProperty(name);
  });
});

describe('KnowledgeTarget', () => {
  it.each([
    { name: 'you, with nothing else', input: { scope: 'you' }, ok: true },
    { name: 'a project', input: { scope: 'project', projectId }, ok: true },
    { name: 'an area of a project', input: { scope: 'area', projectId, area: 'api' }, ok: true },
    { name: 'a project scope with no project', input: { scope: 'project' }, ok: false },
    { name: 'an area scope with no area', input: { scope: 'area', projectId }, ok: false },
    {
      name: 'an area name with capitals',
      input: { scope: 'area', projectId, area: 'API' },
      ok: false,
    },
    { name: 'an unknown scope', input: { scope: 'team', projectId }, ok: false },
  ])('$name: $ok', ({ input, ok }) => {
    expect(KnowledgeTarget.safeParse(input).success).toBe(ok);
  });

  it.each([
    { target: { scope: 'you' as const }, columns: { scope: 'you', projectId: null, area: null } },
    {
      target: { scope: 'project' as const, projectId },
      columns: { scope: 'project', projectId, area: null },
    },
    {
      target: { scope: 'area' as const, projectId, area: 'ui' },
      columns: { scope: 'area', projectId, area: 'ui' },
    },
  ])('stores $target.scope as its columns', ({ target, columns }) => {
    expect(targetColumns(target)).toEqual(columns);
  });
});

describe('topic keys', () => {
  it.each([
    { name: 'dotted words', key: 'testing.no-sleeps', ok: true },
    { name: 'one word', key: 'commits', ok: true },
    { name: 'capitals', key: 'Testing', ok: false },
    { name: 'a space', key: 'no sleeps', ok: false },
    { name: 'a leading dot', key: '.hidden', ok: false },
    { name: 'a doubled separator', key: 'a..b', ok: false },
    { name: 'empty', key: '', ok: false },
    { name: '81 characters', key: 'a'.repeat(81), ok: false },
  ])('TopicKey accepts $name: $ok', ({ key, ok }) => {
    expect(TopicKey.safeParse(key).success).toBe(ok);
  });

  it('limits a key to 80 characters', () => {
    expect(TOPIC_KEY_MAX).toBe(80);
  });

  it.each([
    { text: 'Never sleep in tests!', key: 'never-sleep-in-tests' },
    { text: '  Which queue library?  ', key: 'which-queue-library' },
    { text: 'Ünïcode only: ±±±', key: 'n-code-only' },
    { text: '???', key: 'untitled-7bcac7' },
    { text: '  ???  ', key: 'untitled-7bcac7' },
    { text: 'x'.repeat(120), key: 'x'.repeat(80) },
    { text: `${'word '.repeat(30)}end`, key: Array.from({ length: 16 }, () => 'word').join('-') },
  ])('makes $key from $text', ({ text, key }) => {
    expect(topicKeyFrom(text)).toBe(key);
    expect(TopicKey.safeParse(topicKeyFrom(text)).success).toBe(true);
  });

  it('gives two statements without Latin words different keys, so neither supersedes the other', () => {
    const first = topicKeyFrom('永远不要在测试中休眠');
    const second = topicKeyFrom('テストでスリープしない');
    expect(first).toMatch(/^untitled-[0-9a-f]{6}$/);
    expect(second).toMatch(/^untitled-[0-9a-f]{6}$/);
    expect(first).not.toBe(second);
    expect(topicKeyFrom('永远不要在测试中休眠')).toBe(first);
  });
});

describe('PrincipleDraft', () => {
  it.each([
    { name: 'a bare statement', input: { statement: 'Prefer small PRs' }, ok: true },
    {
      name: 'every field',
      input: {
        statement: 'Never sleep in tests',
        kind: 'policy',
        topicKey: 'testing.no-sleeps',
        scope: 'area',
        area: 'api',
        quote: 'never sleep in a test',
        rationale: 'sleeps make tests slow and flaky',
      },
      ok: true,
    },
    { name: 'an empty statement', input: { statement: '   ' }, ok: false },
    { name: 'an area scope without an area', input: { statement: 's', scope: 'area' }, ok: false },
    { name: 'an area on a project scope', input: { statement: 's', area: 'api' }, ok: false },
    { name: 'a statement over 500 characters', input: { statement: 'x'.repeat(501) }, ok: false },
  ])('$name: $ok', ({ input, ok }) => {
    expect(PrincipleDraft.safeParse(input).success).toBe(ok);
  });

  it('defaults to a project heuristic', () => {
    expect(PrincipleDraft.parse({ statement: 'Prefer small PRs' })).toMatchObject({
      kind: 'heuristic',
      scope: 'project',
    });
  });
});

describe('DecisionInput', () => {
  it('trims the text and refuses a blank choice', () => {
    const base = { target: { scope: 'you' }, question: ' Q? ', choice: ' C ', rationale: ' R ' };
    expect(DecisionInput.parse(base)).toMatchObject({
      question: 'Q?',
      choice: 'C',
      rationale: 'R',
    });
    expect(DecisionInput.safeParse({ ...base, choice: '  ' }).success).toBe(false);
  });
});

describe('InboxAnswer.record', () => {
  it.each([
    { name: 'absent', input: { choice: 'Teal' }, ok: true },
    { name: 'null, to record nothing', input: { choice: 'Teal', record: null }, ok: true },
    {
      name: 'a project scope',
      input: { choice: 'Teal', record: { scope: 'project', area: null } },
      ok: true,
    },
    {
      name: 'an area scope with its area',
      input: { choice: 'Teal', record: { scope: 'area', area: 'ui' } },
      ok: true,
    },
    {
      name: 'an area scope with no area',
      input: { choice: 'Teal', record: { scope: 'area', area: null } },
      ok: false,
    },
    {
      name: 'an area on a you scope',
      input: { choice: 'Teal', record: { scope: 'you', area: 'ui' } },
      ok: false,
    },
  ])('$name: $ok', ({ input, ok }) => {
    expect(InboxAnswer.safeParse(input).success).toBe(ok);
  });
});
