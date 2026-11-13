import { describe, expect, it } from 'vitest';
import {
  BundleRevision,
  CodeAnchor,
  mintId,
  parseSectionRef,
  PlanBundle,
  PlanEntryBody,
  PlanImportInput,
  UrlAnchor,
} from './index';

const AT = '2026-11-12T08:00:00.000Z';
const projectId = mintId('Project');

const anchor = (over: Record<string, unknown>) => ({
  kind: 'code',
  path: 'apps/daemon/src/runner/runner.ts',
  line: 18,
  commit: '818d3644',
  excerpt: 'const a = 1;\nconst b = 2;\nconst c = 3;',
  ...over,
});

describe('CodeAnchor', () => {
  it('accepts a 3-line excerpt at line 18', () => {
    expect(CodeAnchor.safeParse(anchor({})).success).toBe(true);
  });

  it.each([
    ['a 6-line excerpt', { excerpt: 'a\nb\nc\nd\ne\nf' }],
    ['a blank excerpt', { excerpt: '  \n ' }],
    ['an excerpt of punctuation only', { excerpt: '}\n);' }],
    ['../x.ts', { path: '../x.ts' }],
    ['/abs.ts', { path: '/abs.ts' }],
    ['a\u0000b', { path: 'a\u0000b' }],
    ['line 0', { line: 0 }],
    ['commit xyz', { commit: 'xyz' }],
  ])('refuses %s', (_, over) => {
    expect(CodeAnchor.safeParse(anchor(over)).success).toBe(false);
  });
});

describe('UrlAnchor', () => {
  it('refuses ftp://x', () => {
    expect(UrlAnchor.safeParse({ kind: 'url', url: 'ftp://x', readAt: '2026-11-12' }).success).toBe(
      false,
    );
  });

  it('accepts https://tailscale.com/kb/1312 read 2026-11-12', () => {
    expect(
      UrlAnchor.safeParse({
        kind: 'url',
        url: 'https://tailscale.com/kb/1312',
        readAt: '2026-11-12',
      }).success,
    ).toBe(true);
  });
});

describe('PlanEntryBody.fact', () => {
  it('takes a claim and a cost body', () => {
    expect(PlanEntryBody.fact.safeParse({ claim: 'The runner packs once' }).success).toBe(true);
    expect(
      PlanEntryBody.fact.safeParse({
        kind: 'cost',
        rows: [{ phase: 'Builder check', agents: 1, tokens: 120000, approximate: true }],
      }).success,
    ).toBe(true);
  });

  it('refuses a cost row with only a phase', () => {
    expect(PlanEntryBody.fact.safeParse({ kind: 'cost', rows: [{ phase: 'x' }] }).success).toBe(
      false,
    );
  });
});

describe('BundleRevision', () => {
  const base = { number: 1, at: AT };
  it('body and bodyPath together are refused', () => {
    expect(BundleRevision.safeParse({ ...base, body: '# P1', bodyPath: 'p1.md' }).success).toBe(
      false,
    );
  });

  it('neither is refused', () => {
    expect(BundleRevision.safeParse(base).success).toBe(false);
  });
});

describe('PlanBundle', () => {
  const minimal = {
    id: 'remote-host.2026-11-12',
    projectId,
    title: 'Remote host',
    origin: { kind: 'claude_code', at: AT },
    documents: [
      { key: 'p1', kind: 'plan', title: 'P1', revisions: [{ number: 1, body: '# P1', at: AT }] },
    ],
  };

  it('a minimal bundle parses with every list defaulted', () => {
    const bundle = PlanBundle.parse(minimal);
    expect(bundle).toMatchObject({
      intent: [],
      entries: [],
      decisions: [],
      findings: [],
      questions: [],
      goals: [],
      tasks: [],
      landings: [],
    });
    expect(bundle.documents[0]?.revisions[0]).toMatchObject({ note: '', author: '' });
  });

  it('an id with a capital is refused', () => {
    expect(PlanBundle.safeParse({ ...minimal, id: 'Remote-host' }).success).toBe(false);
  });

  it('a lone surrogate anywhere in its text is refused, naming where', () => {
    const lone = JSON.parse('"P1 \\ud800"') as string;
    const titled = PlanBundle.safeParse({ ...minimal, title: lone });
    const bodied = PlanBundle.safeParse({
      ...minimal,
      documents: [
        { key: 'p1', kind: 'plan', title: 'P1', revisions: [{ number: 1, body: lone, at: AT }] },
      ],
    });
    expect(titled.error?.issues.map((i) => i.path.join('.'))).toEqual(['title']);
    expect(bodied.error?.issues.map((i) => i.path.join('.'))).toEqual([
      'documents.0.revisions.0.body',
    ]);
  });
});

describe('parseSectionRef', () => {
  it('reads doc#slug', () => {
    expect(parseSectionRef('p1#task-12')).toEqual({ document: 'p1', section: 'task-12' });
  });

  it.each(['p1', '#x', 'P1#x'])('%s is null', (ref) => {
    expect(parseSectionRef(ref)).toBeNull();
  });
});

describe('PlanImportInput', () => {
  it('bundlePath and bundle together are refused', () => {
    expect(
      PlanImportInput.safeParse({
        bundlePath: '/tmp/b.json',
        bundle: {
          id: 'abc',
          projectId,
          title: 'x',
          origin: { kind: 'other', at: AT },
          documents: [],
        },
      }).success,
    ).toBe(false);
  });
});
