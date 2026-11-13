import { PlanBundle, type ProjectId } from '@10db/contracts';

// A small planning effort as a bundle: two goals (one task of the second depends on the first's), a
// loose task, a plan document with task sections and a shared one, a spec, entries, decisions, a
// finding and a question. Tests change a copy of `bundleJson` and parse it.

export const AT = '2026-11-12T08:00:00.000Z';

/** The plan document: three task sections, a shared "Calls made", CRLF and a BOM kept as they are. */
export const P1_BODY = [
  '﻿# Remote host plan',
  '## Task 1: Pair a device',
  'Pair it over the tailnet.  ',
  '## Task 2: Revoke a device\r',
  'Revoke it.',
  '## Task 3: Show the host',
  'Show it.',
  '## Calls made',
  'Settings › Sharing is where it lives.',
  '',
].join('\n');

export const SPEC_BODY = '# Remote host spec\n## Scope\nPairing only.\n';

/** The bundle as JSON, before parsing: a fresh copy each call, safe to change. */
export function bundleJson(projectId: ProjectId): Record<string, unknown> {
  return {
    id: 'remote-host.2026-11-12',
    projectId,
    title: 'Remote host',
    origin: { kind: 'claude_code', session: 'ses-abc', model: 'claude-opus-5-5', at: AT },
    intent: [
      {
        key: 'i1',
        quote: 'Plans never go in the repo.\nThey stay local.',
        speaker: 'builder',
        saidAt: '2026-11-12',
      },
    ],
    documents: [
      {
        key: 'p1',
        kind: 'plan',
        title: 'P1',
        revisions: [{ number: 1, body: P1_BODY, note: 'first', author: 'opus', at: AT }],
      },
      {
        key: 's1',
        kind: 'spec',
        title: 'Remote host spec',
        effort: 'g1',
        revisions: [{ number: 1, body: SPEC_BODY, at: AT }],
      },
    ],
    entries: [
      {
        key: 'f1',
        kind: 'fact',
        title: 'The runner packs once',
        body: { claim: 'The runner packs the context once per session.' },
        anchors: [
          {
            kind: 'code',
            path: 'src/runner.ts',
            line: 3,
            commit: '818d3644',
            excerpt: 'const pack = build();',
          },
        ],
        sources: ['capture §6a'],
        verified: true,
        checkedAt: '2026-11-12',
      },
      {
        key: 'n1',
        kind: 'name',
        title: 'Host',
        body: { name: 'Host', kind: 'type', definition: 'The Mac 10db runs on', owner: 'daemon' },
        verified: true,
        checkedAt: null,
      },
      {
        key: 'x1',
        kind: 'experiment',
        title: 'Ping over the tailnet',
        body: {
          setup: 'Two Macs',
          command: 'tailscale ping host',
          output: 'pong from host in 3ms\n',
          shows: 'The tailnet reaches the host',
        },
        verified: true,
        checkedAt: '2026-11-12',
      },
    ],
    decisions: [
      {
        key: 'd1',
        question: 'Where does the record live?',
        choice: 'In the database',
        rationale: 'Local only',
        alternatives: [{ option: 'Docs PRs', whyNot: 'They land in the repo' }],
        quote: 'Plans never go in the repo.',
        lasting: true,
        scope: 'project',
        decidedAt: '2026-11-12',
      },
      {
        key: 'd2',
        question: 'Which port for pairing?',
        choice: '7443',
        rationale: 'Free on the host',
        lasting: false,
        scope: 'project',
      },
    ],
    findings: [
      {
        key: 'p1-r1-1',
        document: 'p1',
        revision: 1,
        section: 'task-2',
        reviewer: 'fable plan reviewer',
        round: 1,
        severity: 'high',
        severityText: 'blocking, security',
        text: 'Revoked devices keep their session',
        state: 'resolved',
        outcomeText: 'partial: revoked-device column is a stub',
        how: 'Added the column',
        howDetail: 'The column exists; nothing writes it yet.',
      },
    ],
    questions: [{ key: 'q1', text: 'Which port?', owner: 'designer', about: 't1', blocks: 'P2' }],
    goals: [
      {
        key: 'g1',
        title: 'Pairing',
        objective: 'A device pairs with the host.',
        cares_most: 'Nothing leaks',
        tasks: [
          {
            key: 't1',
            title: 'Pair a device',
            why: 'Pairing comes first',
            criteria: ['A device pairs'],
            areas: ['api'],
            size: 'S',
            planRef: { document: 'p1', revision: 1, section: 'task-1', shared: ['calls-made'] },
            cites: ['f1', 'd1', 'i1', 'n1', 'x1'],
          },
          {
            key: 't2',
            title: 'Revoke a device',
            criteria: ['A device is revoked'],
            areas: ['api'],
            dependsOn: ['t1'],
            planRef: { document: 'p1', revision: 1, section: 'task-2', shared: ['calls-made'] },
          },
        ],
      },
      {
        key: 'g2',
        title: 'Showing',
        objective: 'The app shows the host.',
        ceremony: 'direct',
        tasks: [
          {
            key: 't3',
            title: 'Show the host',
            criteria: ['The host shows'],
            areas: ['ui'],
            dependsOn: ['t1'],
            planRef: { document: 'p1', revision: 1, section: 'task-3' },
          },
        ],
      },
    ],
    tasks: [
      {
        key: 't4',
        title: 'Document pairing',
        criteria: ['A guide exists'],
        areas: ['ui'],
        ceremony: 'spec',
        size: 'L',
      },
    ],
    landings: [{ key: 'l1', title: 'Pairing lands', keys: ['t1', 't2'] }],
  };
}

export function parseBundle(json: Record<string, unknown>): PlanBundle {
  return PlanBundle.parse(json);
}

/** A bundle's bodies by `doc#number`, as `inlineBundle` gives them. */
export function inlineBodies(bundle: PlanBundle): Map<string, string> {
  return new Map(
    bundle.documents.flatMap((d) =>
      d.revisions.map((r): [string, string] => [`${d.key}#${String(r.number)}`, r.body ?? '']),
    ),
  );
}
