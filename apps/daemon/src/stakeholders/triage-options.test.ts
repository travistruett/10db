import {
  mintId,
  QUESTION_CATEGORY_HINTS,
  type PersonDto,
  type PersonId,
  type RoutingRuleDto,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { triageOptions } from './triage-options';

const AT = '2026-11-12T10:00:00.000Z';
const person = (handle: string, name: string): PersonDto => ({
  id: mintId('Person'),
  handle,
  name,
  isBuilder: false,
  slack: null,
  createdAt: AT,
  updatedAt: AT,
});
const mark = person('mark', 'Mark Ellis');
const ana = person('ana', 'Ana Ortiz');
const sarah = person('sarah', 'Sarah');
const people = [mark, ana, sarah];

const route = (
  personId: PersonId,
  over: Partial<Pick<RoutingRuleDto, 'category' | 'topic' | 'area' | 'goalId'>> = {},
): RoutingRuleDto => ({
  id: mintId('RoutingRule'),
  projectId: mintId('Project'),
  category: 'product',
  topic: null,
  goalId: null,
  taskId: null,
  area: null,
  personId,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

describe('triageOptions', () => {
  it('offers only nobody when no route can be chosen', () => {
    const out = triageOptions([], people, QUESTION_CATEGORY_HINTS);
    expect(out.options).toEqual(['nobody']);
    expect(out.criteria).toEqual({ nobody: 'None of these: the builder answers it' });
    expect(out.peopleFor).toEqual({});
  });

  it('offers one option per category with project routes, with the hint and who answers', () => {
    const out = triageOptions(
      [route(mark.id), route(ana.id, { category: 'design' })],
      people,
      QUESTION_CATEGORY_HINTS,
    );
    expect(out.options).toEqual(['category:product', 'category:design', 'nobody']);
    expect(out.criteria['category:product']).toBe(
      "Product: What should it do? Scope, behaviour, priorities, who it's for. Answered by Mark Ellis.",
    );
    expect(out.peopleFor).toEqual({
      'category:product': [mark.id],
      'category:design': [ana.id],
    });
  });

  it('keeps a tie on a category together, in routing order', () => {
    const out = triageOptions([route(ana.id), route(mark.id)], people, QUESTION_CATEGORY_HINTS);
    expect(out.options).toEqual(['category:product', 'nobody']);
    expect(out.peopleFor['category:product']).toEqual([ana.id, mark.id]);
    expect(out.criteria['category:product']).toMatch(/Answered by Ana Ortiz and Mark Ellis\.$/);
  });

  it('offers one option per topic route, named by the route id', () => {
    const billing = route(sarah.id, { category: null, topic: 'billing' });
    const out = triageOptions([billing], people, QUESTION_CATEGORY_HINTS);
    expect(out.options).toEqual([`topic:${billing.id}`, 'nobody']);
    expect(out.criteria[`topic:${billing.id}`]).toBe('Topic: billing. Answered by Sarah.');
    expect(out.peopleFor[`topic:${billing.id}`]).toEqual([sarah.id]);
  });

  it('keeps a topic with two people as one option', () => {
    const first = route(sarah.id, { category: null, topic: 'billing' });
    const second = route(mark.id, { category: null, topic: 'billing' });
    const out = triageOptions([first, second], people, QUESTION_CATEGORY_HINTS);
    expect(out.options).toEqual([`topic:${first.id}`, 'nobody']);
    expect(out.peopleFor[`topic:${first.id}`]).toEqual([sarah.id, mark.id]);
  });

  it.each([
    ['a goal route', route(mark.id, { goalId: mintId('Goal') })],
    ['an area route', route(mark.id, { area: 'ui' })],
  ])('leaves out %s, which an explicit rule already handles', (_name, row) => {
    expect(triageOptions([row], people, QUESTION_CATEGORY_HINTS).options).toEqual(['nobody']);
  });

  it('skips a person who no longer exists', () => {
    const out = triageOptions(
      [route(mintId('Person')), route(mark.id)],
      people,
      QUESTION_CATEGORY_HINTS,
    );
    expect(out.peopleFor['category:product']).toEqual([mark.id]);
  });
});
