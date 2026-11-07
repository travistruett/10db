import { Effort } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { aaSlugFor } from './slugs';

const LISTED: ReadonlySet<string> = new Set([
  'gpt-5-6-sol-high',
  'gpt-5-6-sol-low',
  'claude-opus-5-5',
  'claude-opus-5-5-high',
  'lab-one-2',
]);

describe('aaSlugFor', () => {
  it.each([
    {
      name: 'dots become hyphens and the effort follows',
      model: 'gpt-5.6-sol',
      effort: Effort.High,
      slug: 'gpt-5-6-sol-high',
    },
    {
      name: 'max is the bare slug',
      model: 'claude-opus-5-5',
      effort: Effort.Max,
      slug: 'claude-opus-5-5',
    },
    {
      name: 'a dotted id at max is the bare slug',
      model: 'claude-opus-5.5',
      effort: Effort.Max,
      slug: 'claude-opus-5-5',
    },
    {
      name: 'a lower effort keeps its suffix',
      model: 'claude-opus-5-5',
      effort: Effort.High,
      slug: 'claude-opus-5-5-high',
    },
    { name: 'an effort AA does not list', model: 'gpt-5.6-sol', effort: Effort.Medium, slug: null },
    { name: 'a model AA does not list', model: 'lab-two-3', effort: Effort.Max, slug: null },
    {
      name: 'a bare slug does not stand in for an effort',
      model: 'lab-one-2',
      effort: Effort.High,
      slug: null,
    },
    { name: 'a bare slug at max', model: 'lab-one-2', effort: Effort.Max, slug: 'lab-one-2' },
  ])('$name', ({ model, effort, slug }) => {
    expect(aaSlugFor(model, effort, LISTED)).toBe(slug);
  });
});
