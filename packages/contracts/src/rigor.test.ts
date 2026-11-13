import { describe, expect, it } from 'vitest';
import { ModelSetting } from './catalogue';
import { mintId } from './ids';
import {
  effectiveRigor,
  KindInput,
  KindOrderInput,
  kindsMatchingRiskTags,
  kindsOfTask,
  KindPatch,
  ModelPicksQuery,
  PlaybookInput,
  Rigor,
  RIGORS,
  RigorBelowKindError,
  refuseRigorBelowKinds,
  withKindsNamed,
  rigorAtLeast,
  type TaskKind,
} from './rigor';
import type { RiskTag } from './states';

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
    {
      name: 'a row with a plan review and no plan',
      value: { rows: [{ rigor: 'careful', steps: ['plan_review', 'implement'] }] },
      ok: false,
    },
    {
      name: 'a row with a plan review and a plan',
      value: { rows: [{ rigor: 'careful', steps: ['plan', 'plan_review', 'implement'] }] },
      ok: true,
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

describe('effectiveRigor', () => {
  const kinds = [
    { key: 'security', minimumRigor: Rigor.Careful },
    { key: 'dependency', minimumRigor: Rigor.Standard },
    { key: 'docs', minimumRigor: null },
  ];
  const task = (...keys: string[]): TaskKind[] => keys.map((key) => ({ key, source: 'agent' }));

  it.each([
    {
      name: 'no rigor and no kinds takes the project default',
      def: 'standard',
      own: null,
      keys: [],
      want: 'standard',
    },
    {
      name: 'its own rigor beats the default',
      def: 'standard',
      own: 'light',
      keys: [],
      want: 'light',
    },
    {
      name: 'a kind with no minimum changes nothing',
      def: 'light',
      own: null,
      keys: ['docs'],
      want: 'light',
    },
    {
      name: 'a kind raises a default below its minimum',
      def: 'light',
      own: null,
      keys: ['security'],
      want: 'careful',
    },
    {
      name: 'a kind raises the rigor the builder set too',
      def: 'standard',
      own: 'light',
      keys: ['security'],
      want: 'careful',
    },
    {
      name: 'a rigor above the minimum stays',
      def: 'standard',
      own: 'critical',
      keys: ['security'],
      want: 'critical',
    },
    {
      name: 'the strongest minimum of several kinds wins',
      def: 'light',
      own: null,
      keys: ['dependency', 'security'],
      want: 'careful',
    },
    {
      name: 'a key no kind has adds nothing',
      def: 'light',
      own: null,
      keys: ['gone'],
      want: 'light',
    },
  ] as const)('$name', ({ def, own, keys, want }) => {
    expect(
      effectiveRigor({ rigor: own, projectDefault: def, taskKinds: task(...keys), kinds }),
    ).toBe(want);
  });
});

describe('the query, order and refusal the routes add', () => {
  const account = mintId('Account');
  const kindId = mintId('Kind');

  it.each([
    { name: 'an account alone', query: { account }, ok: true },
    { name: 'an account and a rigor', query: { account, rigor: 'careful' }, ok: true },
    {
      name: 'an account, a rigor and a project',
      query: { account, rigor: 'careful', project: mintId('Project') },
      ok: true,
    },
    { name: 'a project that is not an ID', query: { account, project: 'mine' }, ok: false },
    { name: 'a rigor that does not exist', query: { account, rigor: 'extreme' }, ok: false },
    { name: 'no account', query: { rigor: 'light' }, ok: false },
  ])('ModelPicksQuery reads $name', ({ query, ok }) => {
    expect(ModelPicksQuery.safeParse(query).success).toBe(ok);
  });

  it.each([
    {
      name: 'the first place',
      value: { kindId: kindId, position: 0 },
      ok: true,
    },
    {
      name: 'a negative place',
      value: { kindId: kindId, position: -1 },
      ok: false,
    },
    {
      name: 'a task id',
      value: { kindId: mintId('Task'), position: 1 },
      ok: false,
    },
  ])('KindOrderInput reads $name', ({ value, ok }) => {
    expect(KindOrderInput.safeParse(value).success).toBe(ok);
  });

  it('names the kind and its minimum when a rigor is too low', () => {
    const error = new RigorBelowKindError(
      { key: 'security', label: 'Security' },
      'careful',
      'light',
    );
    expect(error.code).toBe('invalid');
    expect(error.kindKey).toBe('security');
    expect(error.message).toContain('Security');
    expect(error.message).toContain('careful');
  });
});

describe('refuseRigorBelowKinds', () => {
  const kinds = [
    { key: 'security', label: 'Security', minimumRigor: Rigor.Careful },
    { key: 'migration', label: 'Migration', minimumRigor: Rigor.Critical },
    { key: 'docs', label: 'Docs', minimumRigor: null },
  ];
  const own = (...keys: string[]) => keys.map((key) => ({ key }));

  it.each([
    {
      name: 'no rigor of its own follows the floor',
      rigor: null,
      has: ['security'],
      refused: null,
    },
    { name: 'a rigor at the floor', rigor: Rigor.Careful, has: ['security'], refused: null },
    { name: 'a rigor above the floor', rigor: Rigor.Critical, has: ['security'], refused: null },
    { name: 'a rigor below the floor', rigor: Rigor.Light, has: ['security'], refused: 'security' },
    { name: 'a kind with no minimum', rigor: Rigor.Light, has: ['docs'], refused: null },
    { name: 'a key no kind has', rigor: Rigor.Light, has: ['gone'], refused: null },
    { name: 'no kinds', rigor: Rigor.Light, has: [], refused: null },
    {
      name: 'two floors name the strongest',
      rigor: Rigor.Standard,
      has: ['security', 'migration'],
      refused: 'migration',
    },
    {
      name: 'a rigor that meets one floor and misses the other',
      rigor: Rigor.Careful,
      has: ['security', 'migration'],
      refused: 'migration',
    },
  ])('$name', ({ rigor, has, refused }) => {
    const call = () => {
      refuseRigorBelowKinds({ rigor, taskKinds: own(...has), kinds });
    };
    if (refused === null) call();
    else
      expect(call).toThrow(
        expect.objectContaining({ name: 'RigorBelowKindError', kindKey: refused }),
      );
  });
});

describe('kindsOfTask and withKindsNamed', () => {
  const known = [{ key: 'security' }, { key: 'auth' }, { key: 'ui' }];

  it('finds the rows a task names, in the builder’s order, and skips a deleted kind', () => {
    const taskKinds = [{ key: 'ui' }, { key: 'gone' }, { key: 'security' }];
    expect(kindsOfTask(taskKinds, known)).toEqual([{ key: 'security' }, { key: 'ui' }]);
  });

  it.each([
    { name: 'adds a known key', have: [], keys: ['auth'], want: ['auth:agent'] },
    {
      name: 'keeps what the task has and its source',
      have: [['ui', 'builder']],
      keys: ['ui', 'auth'],
      want: ['ui:builder', 'auth:agent'],
    },
    { name: 'drops a key no kind has', have: [], keys: ['gone', 'ui'], want: ['ui:agent'] },
    { name: 'adds a key given twice once', have: [], keys: ['ui', 'ui'], want: ['ui:agent'] },
  ] as { name: string; have: [string, TaskKind['source']][]; keys: string[]; want: string[] }[])(
    'withKindsNamed $name',
    ({ have, keys, want }) => {
      const taskKinds: TaskKind[] = have.map(([key, source]) => ({ key, source }));
      const result = withKindsNamed(taskKinds, keys, known, 'agent');
      expect(result.map((k) => `${k.key}:${k.source}`)).toEqual(want);
    },
  );
});

describe('kindsMatchingRiskTags', () => {
  const known = ['security', 'auth', 'migration', 'dependency', 'ui'].map((key) => ({ key }));
  const own = (...pairs: [string, TaskKind['source']][]): TaskKind[] =>
    pairs.map(([key, source]) => ({ key, source }));
  const names = (kinds: readonly TaskKind[]) => kinds.map((k) => `${k.key}:${k.source}`);

  it.each([
    {
      name: 'sets the risky kinds to the tags',
      have: [],
      tags: ['migration'],
      want: ['migration:builder'],
    },
    {
      name: 'swaps a risky kind for another tag',
      have: [['migration', 'agent']],
      tags: ['dependency'],
      want: ['dependency:builder'],
    },
    { name: 'clears the risky kinds with no tags', have: [['auth', 'agent']], tags: [], want: [] },
    {
      name: 'keeps a kind that is not risky and one a tag keeps',
      have: [
        ['ui', 'agent'],
        ['auth', 'agent'],
      ],
      tags: ['auth'],
      want: ['ui:agent', 'auth:agent'],
    },
  ] as { name: string; have: [string, TaskKind['source']][]; tags: RiskTag[]; want: string[] }[])(
    '$name',
    ({ have, tags, want }) => {
      expect(names(kindsMatchingRiskTags(own(...have), tags, known, 'builder'))).toEqual(want);
    },
  );

  it('adds nothing for a tag whose kind the builder deleted', () => {
    expect(kindsMatchingRiskTags([], ['migration'], [{ key: 'ui' }], 'builder')).toEqual([]);
  });
});
