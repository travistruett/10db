import { mintId, type AnchorCheckDto, type PlanContext } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { renderPlanContext } from './plan-context-text';

const workstreamId = mintId('Workstream');
const AT = '2026-11-12T08:00:00.000Z';
const CODE = {
  kind: 'code',
  path: 'src/runner.ts',
  line: 18,
  commit: '818d3644',
  excerpt: 'pack()',
} as const;

const check = (over: Partial<AnchorCheckDto>): AnchorCheckDto => ({
  entryKey: 'f1',
  entryVersion: 1,
  anchorIndex: 0,
  result: 'current',
  line: 18,
  checkedCommit: 'abcdef1234567',
  note: null,
  workstreamId,
  at: AT,
  ...over,
});

const SECTION = '## Task 1: Pair\r\nPair it.  \r\n';

function plan(over: Partial<PlanContext> = {}): PlanContext {
  return {
    shapeId: mintId('Shape'),
    revisionId: mintId('ShapeAttachmentRevision'),
    title: 'Remote host',
    document: { key: 'p1', title: 'P1', revision: 2 },
    goal: { objective: 'A device pairs.', why: 'Nothing leaks' },
    section: { ref: 'p1#task-1', text: SECTION },
    shared: [{ ref: 'p1#calls-made', text: '## Calls made\nOne.\n' }],
    decisions: [
      { key: 'd1', choice: 'The database', rationale: 'Local only', lasting: true, dropped: null },
    ],
    names: [
      { key: 'n1', version: 1, name: 'Host', definition: 'The Mac 10db runs on', dropped: null },
    ],
    facts: [
      {
        key: 'f1',
        version: 1,
        kind: 'fact',
        line: 'Packs once',
        anchors: [CODE],
        checks: [],
        dropped: null,
      },
    ],
    findings: [{ key: 'p1-r1-1', severity: 'blocking, security', text: 'Revoked devices stay' }],
    intent: [
      { key: 'i1', version: 1, quote: 'Never in the repo.', speaker: 'builder', dropped: null },
    ],
    notIncluded: [],
    budget: 6000,
    used: 40,
    ...over,
  };
}

const factWith = (
  checks: AnchorCheckDto[],
  anchors: PlanContext['facts'][number]['anchors'] = [CODE],
) =>
  plan({
    facts: [
      { key: 'f1', version: 1, kind: 'fact', line: 'Packs once', anchors, checks, dropped: null },
    ],
  });
const factLine = (p: PlanContext) => renderPlanContext(p).find((l) => l.startsWith('- f1:'));

describe('renderPlanContext', () => {
  it.each([
    [
      'a moved anchor reads Anchor moved with both lines',
      [check({ result: 'moved', line: 21 })],
      '- f1: Packs once — Anchor moved: src/runner.ts:18→21',
    ],
    [
      'a changed anchor reads Anchor changed',
      [check({ result: 'changed', line: null })],
      '- f1: Packs once — Anchor changed: src/runner.ts:18, the excerpt is not there',
    ],
    [
      'unchecked says not checked with its note',
      [check({ result: 'unchecked', line: null, note: 'the file is over 4 MiB' })],
      '- f1: Packs once — Anchor not checked: the file is over 4 MiB',
    ],
    [
      'no check row says not checked yet',
      [],
      '- f1: Packs once — Anchor not checked yet: src/runner.ts:18',
    ],
    [
      'current names the commit',
      [check({})],
      '- f1: Packs once — src/runner.ts:18, checked at abcdef1',
    ],
  ] as const)('%s', (_, checks, line) => {
    expect(factLine(factWith([...checks]))).toBe(line);
  });

  it('a url anchor names its read date and is never fetched', () => {
    const url = {
      kind: 'url',
      url: 'https://tailscale.com/kb/1312',
      readAt: '2026-11-12',
    } as const;
    expect(factLine(factWith([], [url]))).toBe(
      '- f1: Packs once — https://tailscale.com/kb/1312, read 2026-11-12',
    );
  });

  it('no anchor that is not current reads as checked', () => {
    for (const checks of [
      [check({ result: 'moved', line: 21 })],
      [check({ result: 'changed', line: null })],
      [check({ result: 'unchecked', line: null, note: 'git failed' })],
      [],
    ])
      expect(renderPlanContext(factWith(checks)).filter((l) => l.includes('checked at'))).toEqual(
        [],
      );
  });

  it('the section text is verbatim, CRLF and trailing spaces included', () => {
    const text = renderPlanContext(plan()).join('\n');
    expect(text).toContain(`Your section (p1#task-1):\n${SECTION}`);
  });

  it('shared sections come once each, after the task’s', () => {
    const lines = renderPlanContext(plan());
    const yours = lines.indexOf('Your section (p1#task-1):');
    const shared = lines.indexOf('Shared section (p1#calls-made):');
    expect(yours).toBeGreaterThanOrEqual(0);
    expect(shared).toBeGreaterThan(yours);
    expect(lines.filter((l) => l === 'Shared section (p1#calls-made):')).toHaveLength(1);
  });

  it('a dropped item says so, and a superseded fact shows no anchor', () => {
    const lines = renderPlanContext(
      plan({
        decisions: [
          {
            key: 'd1',
            choice: 'The database',
            rationale: 'Local',
            lasting: true,
            dropped: 'rejected',
          },
        ],
        facts: [
          {
            key: 'f1',
            version: 1,
            kind: 'fact',
            line: 'Packs once',
            anchors: [CODE],
            checks: [],
            dropped: 'superseded',
          },
        ],
      }),
    );
    expect(lines).toContain('- d1: The database — why: Local (lasting) (rejected)');
    expect(lines).toContain('- f1: Packs once (superseded)');
  });

  it('renders every group in order', () => {
    expect(renderPlanContext(plan({ notIncluded: ['x1', 'd9'] }))).toEqual([
      'Plan context (from Plan "Remote host", revision 2 of P1):',
      'Goal: A device pairs. — why: Nothing leaks',
      'Your section (p1#task-1):',
      SECTION,
      'Shared section (p1#calls-made):',
      '## Calls made\nOne.\n',
      'Decisions you rely on:',
      '- d1: The database — why: Local only (lasting)',
      'Names:',
      '- Host — The Mac 10db runs on',
      'Facts:',
      '- f1: Packs once — Anchor not checked yet: src/runner.ts:18',
      'Open findings on this section:',
      '- blocking, security: Revoked devices stay',
      'Intent:',
      '- "Never in the repo." — builder',
      'Not included (call get_plan_entry): x1, d9',
    ]);
  });

  it('empty groups are left out', () => {
    const lines = renderPlanContext(
      plan({
        goal: null,
        shared: [],
        decisions: [],
        names: [],
        facts: [],
        findings: [],
        intent: [],
      }),
    );
    expect(lines).toEqual([
      'Plan context (from Plan "Remote host", revision 2 of P1):',
      'Your section (p1#task-1):',
      SECTION,
    ]);
  });
});
