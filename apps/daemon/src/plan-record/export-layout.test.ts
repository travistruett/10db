import { describe, expect, it } from 'vitest';
import { exportLayout, type PlanRecordForExport } from './export-layout';

const BODY = '﻿# P1\r\n## Task 1: Pair\r\ntrailing  \r\n';

const RECORD: PlanRecordForExport = {
  title: 'Remote host',
  origin: {
    kind: 'claude_code',
    session: 'ses-abc',
    model: 'claude-opus-5-5',
    at: '2026-11-12T08:00:00.000Z',
  },
  documents: [
    { key: 'p1', kind: 'plan', title: 'P1', revision: 2, body: BODY },
    { key: 's1', kind: 'spec', title: 'Spec', revision: 1, body: '# Spec\n' },
  ],
  intent: [
    { key: 'i1', quote: 'Plans never go in the repo.', speaker: 'builder', saidAt: '2026-11-12' },
  ],
  entries: [
    {
      key: 'f1',
      kind: 'fact',
      title: 'Packs once',
      version: 2,
      state: 'current',
      body: { claim: 'The runner packs once.' },
      anchors: [
        { kind: 'code', path: 'src/runner.ts', line: 3, commit: '818d3644', excerpt: 'pack()' },
      ],
      checks: [
        {
          task: 'Pair a device',
          result: 'moved',
          line: 6,
          checkedCommit: 'abcdef1234',
          note: null,
        },
      ],
    },
    {
      key: 'c1',
      kind: 'fact',
      title: 'Cost',
      version: 1,
      state: 'current',
      body: {
        kind: 'cost',
        rows: [
          { phase: 'Builder check', agents: 1, tokens: 120000, approximate: true },
          { phase: 'Plan review', agents: null, tokens: 300000, approximate: false },
        ],
      },
      anchors: [],
      checks: [],
    },
  ],
  decisions: [
    {
      key: 'd1',
      question: 'Where does it live?',
      choice: 'The database',
      rationale: 'Local only',
      alternatives: [{ option: 'Docs PRs', whyNot: 'They land in the repo' }],
      quote: 'Plans never go in the repo.',
      lasting: true,
      decidedAt: '2026-11-12',
      state: 'accepted',
    },
    {
      key: 'd2',
      question: 'Which port?',
      choice: '7443',
      rationale: 'Free',
      alternatives: [],
      quote: null,
      lasting: false,
      decidedAt: null,
      state: 'pending',
    },
  ],
  findings: [
    {
      document: 'p1',
      revision: 1,
      round: 2,
      reviewer: 'fable',
      severity: 'blocking, security',
      text: 'Second round finding',
      state: 'open',
      outcome: null,
      how: null,
    },
    {
      document: 'p1',
      revision: 1,
      round: 1,
      reviewer: 'fable',
      severity: 'high',
      text: 'First round finding',
      state: 'resolved',
      outcome: 'partial: a stub',
      how: 'The column exists; nothing writes it yet.',
    },
    {
      document: 's1',
      revision: 1,
      round: 1,
      reviewer: 'opus',
      severity: 'low',
      text: 'Spec finding',
      state: 'open',
      outcome: null,
      how: null,
    },
  ],
  questions: [{ key: 'q1', text: 'Which port?', for: 'designer', blocks: 'P2', state: 'pending' }],
};

const files = () => new Map(exportLayout(RECORD).map((f) => [f.path, f.text]));

describe('exportLayout', () => {
  it('a document file is the latest revision byte for byte', () => {
    const text = files().get('documents/p1.md') ?? '';
    expect(Buffer.from(text, 'utf8').equals(Buffer.from(BODY, 'utf8'))).toBe(true);
  });

  it('reviews group by document, revision and round', () => {
    const text = files().get('reviews.md') ?? '';
    const order = [
      '## p1, revision 1',
      '### Round 1',
      'First round finding',
      '### Round 2',
      'Second round finding',
      '## s1, revision 1',
      'Spec finding',
    ];
    const at = order.map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain('blocking, security');
    expect(text).toContain('partial: a stub');
    expect(text).toContain('The column exists; nothing writes it yet.');
  });

  it('an effort-only decision says this effort', () => {
    const text = files().get('decisions.md') ?? '';
    expect(text).toMatch(/## d2: Which port\?[\s\S]*This effort only/);
    expect(text).toMatch(/## d1: Where does it live\?[\s\S]*Lasting/);
    expect(text).toContain('Docs PRs: They land in the repo');
  });

  it('pending decisions are listed under questions', () => {
    const text = files().get('questions.md') ?? '';
    expect(text).toContain('q1');
    expect(text).toMatch(/Decisions still open[\s\S]*d2: Which port\?/);
    expect(text).not.toContain('d1');
  });

  it('the README lists every file it writes', () => {
    const all = exportLayout(RECORD);
    const readme = all.find((f) => f.path === 'README.md')?.text ?? '';
    for (const f of all.filter((f) => f.path !== 'README.md'))
      expect(readme).toContain(`(${f.path})`);
    expect(readme).toContain('Plans never go in the repo.');
    expect(readme).toMatch(/\| Builder check \| 1 \| ~120000 \|/);
  });
});
