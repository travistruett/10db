import {
  mintId,
  PlanDecisionRow,
  PlanDocumentRevisionDto,
  PlanEvidenceRow,
  PlanRecordDto,
  PlanRecordPage,
  PlanRecordList,
  type ShapeId,
} from '@10db/contracts';
import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { daemonUrl } from './daemon';

// A Plan's record for UI tests: a plan document with two revisions and a spec, and a row factory per
// list. Each is parsed, so a contract change breaks the fixture first.

const AT = '2026-11-12T08:00:00.000Z';

export const RECORD_SHAPE_ID: ShapeId = mintId('Shape');

export const P1_REVISION_1 = '# Remote host plan\n## Task 1: Pair a device\nPair it first.\n';
export const P1_REVISION_2 = [
  '# Remote host plan',
  '## Starting point',
  'Main at 818d3644.',
  '### What holds',
  'The runner packs once.',
  '## Task 12: Revoke a device',
  'Revoke it over the tailnet.',
  '',
].join('\n');

/** The sections `indexSections` gives a body: each heading's slug, level, title and offsets. */
function sectionsOf(
  body: string,
): { slug: string; level: number; title: string; start: number; end: number }[] {
  const lines = body.split('\n');
  const found: { slug: string; level: number; title: string; start: number }[] = [];
  let offset = 0;
  for (const line of lines) {
    const m = /^(#{1,4}) (.*)$/.exec(line);
    if (m?.[1] && m[2] !== undefined) {
      const title = m[2];
      const task = /^Task (\d+):/.exec(title)?.[1];
      const slug =
        task === undefined
          ? title
              .toLowerCase()
              .replace(/[^a-z0-9 -]/g, '')
              .replace(/ /g, '-')
          : `task-${task}`;
      found.push({ slug, level: m[1].length, title, start: offset });
    }
    offset += line.length + 1;
  }
  return found.map((s, i) => {
    const next = found.slice(i + 1).find((n) => n.level <= s.level);
    return { ...s, end: next?.start ?? body.length };
  });
}

export function planRecordDto(overrides: Partial<PlanRecordDto> = {}): PlanRecordDto {
  return PlanRecordDto.parse({
    shapeId: RECORD_SHAPE_ID,
    title: 'Remote host',
    importedAt: AT,
    origin: { kind: 'claude_code', session: 'ses-abc', model: 'claude-opus-5-5', at: AT },
    documents: [
      {
        key: 'p1',
        kind: 'plan',
        title: 'P1: pairing',
        effortKey: null,
        revisions: [
          {
            number: 1,
            bundleNumber: 1,
            sha256: 'a'.repeat(64),
            note: 'first draft',
            author: 'opus',
            authoredAt: '2026-11-10T08:00:00.000Z',
            createdAt: AT,
            sections: sectionsOf(P1_REVISION_1),
          },
          {
            number: 2,
            bundleNumber: 2,
            sha256: 'b'.repeat(64),
            note: 'after review',
            author: 'opus',
            authoredAt: '2026-11-12T08:00:00.000Z',
            createdAt: AT,
            sections: sectionsOf(P1_REVISION_2),
          },
        ],
      },
      {
        key: 's1',
        kind: 'spec',
        title: 'Remote host spec',
        effortKey: 'g1',
        revisions: [
          {
            number: 1,
            bundleNumber: 1,
            sha256: 'c'.repeat(64),
            note: '',
            author: '',
            authoredAt: AT,
            createdAt: AT,
            sections: sectionsOf('# Spec\n'),
          },
        ],
      },
    ],
    counts: { decisions: 2, evidence: 2, reviews: 1, questions: 1, tasks: 1 },
    ...overrides,
  });
}

/** The bodies by `key#number`. */
export const REVISION_BODIES: Readonly<Record<string, string>> = {
  'p1#1': P1_REVISION_1,
  'p1#2': P1_REVISION_2,
  's1#1': '# Spec\n',
};

export function decisionRow(overrides: Partial<PlanDecisionRow> = {}): PlanDecisionRow {
  return PlanDecisionRow.parse({
    id: mintId('ShapeProposal'),
    key: 'd1',
    question: 'Where does the record live?',
    choice: 'In the database',
    rationale: 'Local only',
    alternatives: [{ option: 'Docs PRs', whyNot: 'They land in the repo' }],
    quote: 'Plans never go in the repo.',
    lasting: true,
    decidedAt: '2026-11-12',
    state: 'pending',
    decisionId: null,
    ...overrides,
  });
}

export function evidenceRow(overrides: Partial<PlanEvidenceRow> = {}): PlanEvidenceRow {
  return PlanEvidenceRow.parse({
    key: 'f1',
    kind: 'fact',
    title: 'The runner packs once',
    version: 1,
    body: { claim: 'The runner packs the context once per session.' },
    anchors: [
      {
        kind: 'code',
        path: 'apps/daemon/src/runner/runner.ts',
        line: 1976,
        commit: '818d3644',
        excerpt: 'const contextPack = buildContextPack(db, getWorkstream(db, id));',
      },
    ],
    sources: ['capture §6a'],
    verified: true,
    checkedAt: '2026-11-12',
    state: 'current',
    checks: [],
    ...overrides,
  });
}

/** One page of a list holding `rows`, as the daemon answers it. */
export function recordPage(
  list: PlanRecordList,
  rows: readonly unknown[],
  extras: { total?: number; page?: number; pageSize?: number; groups?: unknown[] } = {},
): PlanRecordPage {
  return PlanRecordPage.parse({
    list,
    rows,
    total: extras.total ?? rows.length,
    page: extras.page ?? 1,
    pageSize: extras.pageSize ?? 25,
    ...(list === 'reviews' ? { groups: extras.groups ?? [] } : {}),
  });
}

/** Every page request the handlers saw, with its query. */
export interface SeenPage {
  readonly list: string;
  readonly query: URLSearchParams;
}

/**
 * The record's routes over MSW: the record, its revisions, and each list answered by `pages`, which
 * sees the list and its query so a test can answer per filter.
 */
export function planRecordHandlers(
  opts: {
    readonly record?: PlanRecordDto;
    readonly pages?: (list: PlanRecordList, query: URLSearchParams) => PlanRecordPage;
    readonly seen?: SeenPage[];
  } = {},
) {
  const record = opts.record ?? planRecordDto();
  return [
    http.get(daemonUrl('/shapes/:shapeId/record'), () => HttpResponse.json(record)),
    http.get(daemonUrl('/shapes/:shapeId/documents/:key/revisions/:number'), ({ params }) => {
      const key = String(params['key']);
      const number = Number(params['number']);
      const body = REVISION_BODIES[`${key}#${String(number)}`];
      if (body === undefined)
        return HttpResponse.json({ error: 'not_found', message: 'no revision' }, { status: 404 });
      const title = record.documents.find((d) => d.key === key)?.title ?? key;
      return HttpResponse.json(PlanDocumentRevisionDto.parse({ key, number, title, body }));
    }),
    http.get(daemonUrl('/shapes/:shapeId/record/:list'), ({ params, request }) => {
      const list = z.enum(PlanRecordList).parse(params['list']);
      const query = new URL(request.url).searchParams;
      opts.seen?.push({ list, query });
      return HttpResponse.json(opts.pages ? opts.pages(list, query) : recordPage(list, []));
    }),
  ];
}
