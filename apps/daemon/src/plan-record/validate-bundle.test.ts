import { mintId, PlanBundle } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { sha256Of } from './revisions';
import { validateBundle, type StoredRecord } from './validate-bundle';

const AT = '2026-11-12T08:00:00.000Z';
const projectId = mintId('Project');

const P1 = [
  '# P1',
  '## Task 1: One',
  'do one',
  '## Task 2: Two',
  'do two',
  '## Calls made',
  'calls',
  '',
].join('\n');

/** A bundle that breaks no rule; each row changes one thing. */
function valid(): Bundle {
  return {
    id: 'remote-host',
    projectId,
    title: 'Remote host',
    origin: { kind: 'claude_code', at: AT },
    intent: [{ key: 'i1', quote: 'Never in the repo.', speaker: 'builder', saidAt: '2026-11-12' }],
    documents: [
      { key: 'p1', kind: 'plan', title: 'P1', revisions: [{ number: 1, body: P1, at: AT }] },
      {
        key: 's1',
        kind: 'spec',
        title: 'Spec',
        effort: 'g1',
        revisions: [{ number: 1, body: '# Spec\n', at: AT }],
      },
    ],
    entries: [
      {
        key: 'f1',
        kind: 'fact',
        title: 'Packs once',
        body: { claim: 'The runner packs once.' },
        verified: true,
        checkedAt: '2026-11-12',
      },
    ],
    decisions: [
      {
        key: 'd1',
        question: 'Where?',
        choice: 'The database',
        rationale: 'Local only',
        lasting: true,
        scope: 'project',
      },
    ],
    findings: [
      {
        key: 'p1-r1-1',
        document: 'p1',
        revision: 1,
        section: 'task-1',
        reviewer: 'fable',
        round: 1,
        severity: 'high',
        text: 'Too big',
        state: 'open',
      },
    ],
    questions: [{ key: 'q1', text: 'Which port?', about: 't1' }],
    goals: [
      {
        key: 'g1',
        title: 'Remote host',
        objective: 'Reach the host.',
        tasks: [
          {
            key: 't1',
            title: 'One',
            areas: ['api'],
            planRef: { document: 'p1', revision: 1, section: 'task-1', shared: ['calls-made'] },
            cites: ['f1', 'd1', 'i1'],
          },
          { key: 't2', title: 'Two', areas: ['api'], dependsOn: ['t1'] },
        ],
      },
    ],
    tasks: [{ key: 't3', title: 'Three', areas: ['ui'], dependsOn: ['t2'] }],
    landings: [{ key: 'l1', title: 'First', keys: ['t1', 't2'] }],
  };
}

/** What a test may change: any field of the bundle's JSON. */
type Bundle = Record<string, unknown>;
type Item = Record<string, unknown>;

/** The list a field holds; a row that names a field the bundle lacks fails. */
function list(of: Item, field: string): Item[] {
  const value = of[field];
  if (!Array.isArray(value)) throw new Error(`no list ${field}`);
  return value.filter((v): v is Item => typeof v === 'object' && v !== null);
}
function one(of: Item, field: string, index = 0): Item {
  const item = list(of, field)[index];
  if (item === undefined) throw new Error(`no ${field}[${String(index)}]`);
  return item;
}
/** Adds an item to a field's list in place. */
function push(of: Item, field: string, item: Item): void {
  const value = of[field];
  if (!Array.isArray(value)) throw new Error(`no list ${field}`);
  value.push(item);
}
const goal = (b: Bundle) => one(b, 'goals');
const t1 = (b: Bundle) => one(goal(b), 'tasks');

function bodiesOf(bundle: PlanBundle): Map<string, string> {
  return new Map(
    bundle.documents.flatMap((d) =>
      d.revisions.map((r): [string, string] => [`${d.key}#${String(r.number)}`, r.body ?? '']),
    ),
  );
}

function issues(raw: Bundle, stored: StoredRecord | null = null): string[] {
  const bundle = PlanBundle.parse(raw);
  return validateBundle({
    bundle,
    bodies: bodiesOf(bundle),
    projectId,
    areaNames: new Set(['api', 'ui']),
    stored,
  }).map((i) => `${i.path}: ${i.message}`);
}

const storedOf = (over: Partial<StoredRecord> = {}): StoredRecord => ({
  shapeId: mintId('Shape'),
  documents: new Map([
    ['p1', { kind: 'plan', effort: null, revisions: new Map([[1, sha256Of(P1)]]) }],
    ['s1', { kind: 'spec', effort: 'g1', revisions: new Map([[1, sha256Of('# Spec\n')]]) }],
  ]),
  kinds: new Map(),
  ...over,
});

/** Each row: what it breaks, the change, and a pattern the issues must hold. */
const ROWS: readonly (readonly [string, (b: Bundle) => void, RegExp])[] = [
  [
    'the bundle names another project',
    (b) => (b['projectId'] = mintId('Project')),
    /another project/,
  ],
  [
    'a key used twice across kinds',
    (b) => (one(b, 'decisions')['key'] = 'f1'),
    /f1.*used more than once/,
  ],
  [
    'revision numbers that do not increase',
    (b) =>
      (one(b, 'documents', 0)['revisions'] = [
        { number: 2, body: P1, at: AT },
        { number: 1, body: P1, at: AT },
      ]),
    /increase/,
  ],
  [
    'a planRef to a missing document',
    (b) => (t1(b)['planRef'] = { document: 'p9', revision: 1, section: 'task-1' }),
    /Task t1, planRef: .*p9/,
  ],
  [
    'a planRef to a missing revision',
    (b) => (t1(b)['planRef'] = { document: 'p1', revision: 4, section: 'task-1' }),
    /revision 4/,
  ],
  [
    'a planRef to a missing section',
    (b) => (t1(b)['planRef'] = { document: 'p1', revision: 1, section: 'task-12' }),
    /p1#task-12 is not in revision 1 of p1/,
  ],
  [
    'a planRef to a missing shared section',
    (b) => (t1(b)['planRef'] = { document: 'p1', revision: 1, section: 'task-1', shared: ['x'] }),
    /p1#x is not in revision 1 of p1/,
  ],
  ['a cite of an unknown key', (b) => (t1(b)['cites'] = ['nope']), /cites: nope/],
  [
    'a finding on a missing document',
    (b) => (one(b, 'findings')['document'] = 'p9'),
    /Finding p1-r1-1, document/,
  ],
  [
    'a finding on a missing revision',
    (b) => (one(b, 'findings')['revision'] = 3),
    /Finding p1-r1-1, revision/,
  ],
  [
    'a finding on a missing section',
    (b) => (one(b, 'findings')['section'] = 'task-9'),
    /Finding p1-r1-1, section/,
  ],
  [
    'a document effort that names no goal',
    (b) => (one(b, 'documents', 1)['effort'] = 'g9'),
    /effort: g9/,
  ],
  ['an area the project lacks', (b) => (t1(b)['areas'] = ['docs']), /areas: docs/],
  ['a dependsOn of no task', (b) => (t1(b)['dependsOn'] = ['t9']), /depends on: t9/],
  ['a dependency cycle across goal and loose tasks', (b) => (t1(b)['dependsOn'] = ['t3']), /cycle/],
  [
    'two specs of one effort',
    (b) => {
      push(b, 'documents', {
        key: 's2',
        kind: 'spec',
        title: 'Spec 2',
        effort: 'g1',
        revisions: [{ number: 1, body: '# Spec 2\n', at: AT }],
      });
    },
    /two specs/,
  ],
  [
    'a goal over 100 tasks',
    (b) =>
      (goal(b)['tasks'] = Array.from({ length: 101 }, (_, i) => ({
        key: `x${String(i)}`,
        title: 'X',
        areas: ['api'],
      }))),
    /101 tasks/,
  ],
  [
    'a landing key of no task',
    (b) => (one(b, 'landings')['keys'] = ['t9']),
    /Landing l1, keys: t9/,
  ],
  [
    'a task in two landings',
    (b) => {
      push(b, 'landings', { key: 'l2', title: 'Again', keys: ['t2'] });
    },
    /t2 is in two landings/,
  ],
  [
    'a question about no goal or task',
    (b) => (one(b, 'questions')['about'] = 'z9'),
    /Question q1, about: z9/,
  ],
];

describe('validateBundle', () => {
  it('a valid bundle has no issues', () => {
    expect(issues(valid())).toEqual([]);
    expect(issues(valid(), storedOf())).toEqual([]);
  });

  it.each(ROWS)('refuses %s', (_, change, pattern) => {
    const bundle = valid();
    change(bundle);
    expect(issues(bundle).join('\n')).toMatch(pattern);
  });

  it('refuses a stored revision whose text changed, naming the next number', () => {
    const bundle = valid();
    one(bundle, 'documents')['revisions'] = [{ number: 1, body: `${P1}more\n`, at: AT }];
    expect(issues(bundle, storedOf()).join('\n')).toMatch(
      /revision 1 of p1 changed; add it as revision 2/,
    );
  });

  it('refuses a new revision numbered below the highest stored one, naming the next number', () => {
    const r3 = `${P1}three\n`;
    const bundle = valid();
    one(bundle, 'documents')['revisions'] = [
      { number: 1, body: P1, at: AT },
      { number: 2, body: `${P1}two\n`, at: AT },
      { number: 3, body: r3, at: AT },
    ];
    const stored = storedOf({
      documents: new Map([
        [
          'p1',
          {
            kind: 'plan',
            effort: null,
            revisions: new Map([
              [1, sha256Of(P1)],
              [3, sha256Of(r3)],
            ]),
          },
        ],
        ['s1', { kind: 'spec', effort: 'g1', revisions: new Map([[1, sha256Of('# Spec\n')]]) }],
      ]),
    });
    expect(issues(bundle, stored)).toEqual([
      'Document p1, revision 2: revision 2 of p1 is below its stored revision 3; add it as revision 4',
    ]);
  });

  it('refuses a document whose kind changed on re-import', () => {
    const bundle = valid();
    one(bundle, 'documents')['kind'] = 'guide';
    expect(issues(bundle, storedOf()).join('\n')).toMatch(/Document p1, kind: .*plan/);
  });

  it('refuses a spec of an effort that another document is stored as', () => {
    const stored = storedOf({
      documents: new Map([
        ['p1', { kind: 'plan', effort: null, revisions: new Map([[1, sha256Of(P1)]]) }],
        ['s0', { kind: 'spec', effort: 'g1', revisions: new Map([[1, 'x']]) }],
      ]),
    });
    expect(issues(valid(), stored).join('\n')).toMatch(/s0 is stored as the spec of g1/);
  });

  it('refuses a key stored under another kind', () => {
    const stored = storedOf({ kinds: new Map([['f1', 'decision']]) });
    expect(issues(valid(), stored).join('\n')).toMatch(/f1.*stored as a decision/);
  });

  it('a chain of 20,000 tasks is checked without exhausting the stack', () => {
    const bundle = valid();
    bundle['tasks'] = Array.from({ length: 20_000 }, (_, i) => ({
      key: `c${String(i)}`,
      title: 'Chain',
      areas: ['ui'],
      ...(i > 0 ? { dependsOn: [`c${String(i - 1)}`] } : { dependsOn: ['c19999'] }),
    }));
    expect(issues(bundle).join('\n')).toMatch(/A dependency cycle: c0 → c19999 → /);
  });

  it('three problems are three issues at once', () => {
    const bundle = valid();
    bundle['projectId'] = mintId('Project');
    t1(bundle)['areas'] = ['docs'];
    t1(bundle)['cites'] = ['nope'];
    expect(issues(bundle)).toHaveLength(3);
  });
});
