import { describe, expect, it } from 'vitest';
import { ModelSetting } from './catalogue';
import { KindInput, KindPatch, PlaybookInput, Rigor, RIGORS, rigorAtLeast } from './rigor';

describe('rigorAtLeast', () => {
  it.each(
    RIGORS.flatMap((rigor, i) =>
      RIGORS.map((minimum, j) => ({
        name: `${rigor} against ${minimum}`,
        rigor,
        minimum,
        expected: i >= j,
      })),
    ),
  )('$name: $expected', ({ rigor, minimum, expected }) => {
    expect(rigorAtLeast(rigor, minimum)).toBe(expected);
  });
});

describe('ModelSetting with a requirement', () => {
  it.each([
    { name: 'an old automatic row', value: { kind: 'automatic' }, ok: true },
    { name: 'automatic at least 40', value: { kind: 'automatic', minimum: 40 }, ok: true },
    { name: 'a minimum above 100', value: { kind: 'automatic', minimum: 101 }, ok: false },
    { name: 'a negative minimum', value: { kind: 'automatic', minimum: -1 }, ok: false },
    { name: 'an old top of tier row', value: { kind: 'top_of_tier' }, ok: true },
    {
      name: 'top of capable',
      value: { kind: 'top_of_tier', tier: 'capable' },
      ok: true,
    },
    { name: 'top of a tier that is not one', value: { kind: 'top_of_tier', tier: 'x' }, ok: false },
  ])('$name: parses $ok', ({ value, ok }) => {
    expect(ModelSetting.safeParse(value).success).toBe(ok);
  });
});

describe('PlaybookInput', () => {
  it.each([
    {
      name: 'a row with build',
      value: { rows: [{ rigor: 'light', steps: ['implement'] }] },
      ok: true,
    },
    { name: 'a row cleared', value: { rows: [{ rigor: 'light', steps: null }] }, ok: true },
    {
      name: 'a row without build',
      value: { rows: [{ rigor: 'standard', steps: ['review'] }] },
      ok: false,
    },
    {
      name: 'a rigor set twice',
      value: {
        rows: [
          { rigor: 'light', steps: ['implement'] },
          { rigor: 'light', steps: ['implement', 'review'] },
        ],
      },
      ok: false,
    },
    {
      name: 'a cell with an effort only',
      value: { cells: [{ rigor: 'careful', role: 'review', effort: 'high' }] },
      ok: true,
    },
    {
      name: 'a cell set twice',
      value: {
        cells: [
          { rigor: 'careful', role: 'review' },
          { rigor: 'careful', role: 'review', effort: 'low' },
        ],
      },
      ok: false,
    },
    { name: 'nothing', value: {}, ok: true },
  ])('$name: parses $ok', ({ value, ok }) => {
    expect(PlaybookInput.safeParse(value).success).toBe(ok);
  });
});

describe('KindInput and KindPatch', () => {
  it('fills a kind written with its key alone', () => {
    expect(KindInput.parse({ key: 'ui', label: 'UI' })).toMatchObject({
      key: 'ui',
      minimumRigor: null,
      alwaysReviewed: false,
      addsSteps: [],
      overrides: {},
    });
  });

  it('parses a kind with an override on one role', () => {
    const kind = KindInput.parse({
      key: 'security',
      label: 'Security',
      minimumRigor: Rigor.Careful,
      overrides: { review: { model: { kind: 'tier', tier: 'frontier' }, effort: 'high' } },
    });
    expect(kind.overrides.review?.effort).toBe('high');
  });

  it('refuses a patch that names the key, because a key is immutable', () => {
    expect(KindPatch.safeParse({ key: 'other' }).success).toBe(false);
    expect(KindPatch.safeParse({ label: 'Other' }).success).toBe(true);
  });
});
