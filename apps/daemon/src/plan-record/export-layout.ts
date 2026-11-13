import type {
  AnchorResult,
  BundleOrigin,
  PlanAlternative,
  PlanAnchor,
  PlanEntryBody,
  PlanEntryState,
  ShapeFindingState,
  ShapeProposalState,
} from '@10db/contracts';

// A Plan's record as Markdown files: the documents verbatim, and the rest written out for reading.
// Pure: `readRecordForExport` reads the record, `exportPlan` writes these files.

export interface PlanRecordForExport {
  readonly title: string;
  readonly origin: BundleOrigin | null;
  /** Each document's latest revision. */
  readonly documents: readonly {
    readonly key: string;
    readonly kind: string;
    readonly title: string;
    readonly revision: number;
    readonly body: string;
  }[];
  readonly intent: readonly {
    readonly key: string;
    readonly quote: string;
    readonly speaker: string;
    readonly saidAt: string;
  }[];
  readonly entries: readonly {
    readonly key: string;
    readonly kind: 'fact' | 'experiment' | 'name';
    readonly title: string;
    readonly version: number;
    readonly state: PlanEntryState;
    readonly body: PlanEntryBody['fact'] | PlanEntryBody['experiment'] | PlanEntryBody['name'];
    readonly anchors: readonly PlanAnchor[];
    /** The latest check of each anchor, per task that cites the entry. */
    readonly checks: readonly {
      readonly task: string;
      readonly result: AnchorResult;
      readonly line: number | null;
      readonly checkedCommit: string;
      readonly note: string | null;
    }[];
  }[];
  readonly decisions: readonly {
    readonly key: string;
    readonly question: string;
    readonly choice: string;
    readonly rationale: string;
    readonly alternatives: readonly PlanAlternative[];
    readonly quote: string | null;
    readonly lasting: boolean;
    readonly decidedAt: string | null;
    readonly state: ShapeProposalState;
  }[];
  readonly findings: readonly {
    readonly document: string;
    readonly revision: number | null;
    readonly round: number;
    readonly reviewer: string;
    /** The reviewer's own words when kept, else the enum. */
    readonly severity: string | null;
    readonly text: string;
    readonly state: ShapeFindingState;
    readonly outcome: string | null;
    /** The full how when kept, else the one-line one. */
    readonly how: string | null;
  }[];
  readonly questions: readonly {
    readonly key: string;
    readonly text: string;
    readonly for: string;
    readonly blocks: string | null;
    readonly state: ShapeProposalState;
  }[];
}

export interface ExportFile {
  readonly path: string;
  readonly text: string;
}

const quoted = (text: string): string =>
  text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const anchorText = (anchor: PlanAnchor): string =>
  anchor.kind === 'code'
    ? `\`${anchor.path}:${String(anchor.line)}\` at ${anchor.commit.slice(0, 7)}`
    : `${anchor.url}, read ${anchor.readAt}`;

function checkText(check: PlanRecordForExport['entries'][number]['checks'][number]): string {
  const at = check.checkedCommit.slice(0, 7);
  switch (check.result) {
    case 'current':
      return `current at line ${String(check.line ?? '')}, checked at ${at}`;
    case 'moved':
      return `moved to line ${String(check.line ?? '')} at ${at}`;
    case 'changed':
      return `changed: the excerpt is not there at ${at}`;
    case 'unchecked':
      return `not checked: ${check.note ?? 'no reason given'}`;
    case 'url':
      return 'a web page, never fetched';
  }
}

function costRows(record: PlanRecordForExport): string[] {
  return record.entries.flatMap((e) =>
    e.kind === 'fact' && 'rows' in e.body
      ? e.body.rows.map(
          (r) =>
            `| ${r.phase} | ${r.agents === null ? '' : String(r.agents)} | ${r.approximate ? '~' : ''}${String(r.tokens)} |`,
        )
      : [],
  );
}

function readme(record: PlanRecordForExport, files: readonly ExportFile[]): string {
  const o = record.origin;
  const lines = [`# ${record.title}`, ''];
  lines.push(
    o === null
      ? 'Planned in 10db.'
      : `Imported from ${[o.kind, o.session, o.model === undefined ? undefined : `(${o.model})`]
          .filter((p) => p !== undefined)
          .join(' ')} on ${o.at.slice(0, 10)}.`,
    '',
  );
  if (record.intent.length > 0) {
    lines.push('## Intent', '');
    for (const i of record.intent) lines.push(quoted(i.quote), `> — ${i.speaker}, ${i.saidAt}`, '');
  }
  lines.push('## Files', '');
  for (const f of files) {
    const doc = record.documents.find((d) => `documents/${d.key}.md` === f.path);
    lines.push(
      `- [${f.path}](${f.path})${doc ? `: ${doc.title}, revision ${String(doc.revision)}` : ''}`,
    );
  }
  const cost = costRows(record);
  if (cost.length > 0)
    lines.push('', '## Cost', '', '| Phase | Agents | Tokens |', '| --- | --- | --- |', ...cost);
  lines.push('');
  return lines.join('\n');
}

function entriesFile(record: PlanRecordForExport): string {
  const lines = ['# Entries', ''];
  const groups = [
    ['fact', 'Facts'],
    ['experiment', 'Experiments'],
    ['name', 'Names'],
  ] as const;
  for (const [kind, heading] of groups) {
    const entries = record.entries.filter((e) => e.kind === kind);
    if (entries.length === 0) continue;
    lines.push(`## ${heading}`, '');
    for (const e of entries) {
      lines.push(
        `### ${e.key}: ${e.title}`,
        '',
        `Version ${String(e.version)}${e.state === 'superseded' ? ', superseded' : ''}.`,
        '',
      );
      const body = e.body;
      if ('claim' in body) lines.push(body.claim, ...(body.detail ? ['', body.detail] : []));
      else if ('rows' in body)
        lines.push(
          '| Phase | Agents | Tokens |',
          '| --- | --- | --- |',
          ...body.rows.map(
            (r) =>
              `| ${r.phase} | ${r.agents === null ? '' : String(r.agents)} | ${r.approximate ? '~' : ''}${String(r.tokens)} |`,
          ),
          ...(body.note ? ['', body.note] : []),
        );
      else if ('setup' in body)
        lines.push(
          `Setup: ${body.setup}`,
          '',
          '```',
          body.command,
          '```',
          '',
          '```',
          body.output,
          '```',
          '',
          `Shows: ${body.shows}`,
        );
      else lines.push(`${body.name} (${body.kind}, owned by ${body.owner}): ${body.definition}`);
      lines.push('');
      for (const a of e.anchors) lines.push(`- Anchor: ${anchorText(a)}`);
      for (const c of e.checks) lines.push(`- Last check for ${c.task}: ${checkText(c)}`);
      if (e.anchors.length + e.checks.length > 0) lines.push('');
    }
  }
  return lines.join('\n');
}

function decisionsFile(record: PlanRecordForExport): string {
  const lines = ['# Decisions', ''];
  for (const d of record.decisions) {
    lines.push(
      `## ${d.key}: ${d.question}`,
      '',
      `Choice: ${d.choice}`,
      '',
      `Why: ${d.rationale}`,
      '',
    );
    if (d.alternatives.length > 0) {
      lines.push('Turned down:', '');
      for (const a of d.alternatives) lines.push(`- ${a.option}: ${a.whyNot}`);
      lines.push('');
    }
    if (d.quote !== null) lines.push(quoted(d.quote), '');
    lines.push(
      `${d.lasting ? 'Lasting' : 'This effort only'}. ${
        d.decidedAt === null ? `State: ${d.state}.` : `Decided ${d.decidedAt}; state: ${d.state}.`
      }`,
      '',
    );
  }
  return lines.join('\n');
}

function reviewsFile(record: PlanRecordForExport): string {
  const lines = ['# Reviews', ''];
  const documents = [...new Set(record.findings.map((f) => f.document))];
  for (const document of documents) {
    const mine = record.findings.filter((f) => f.document === document);
    const revisions = [...new Set(mine.map((f) => f.revision))].sort((a, b) => (a ?? 0) - (b ?? 0));
    for (const revision of revisions) {
      lines.push(`## ${document}${revision === null ? '' : `, revision ${String(revision)}`}`, '');
      const inRevision = mine.filter((f) => f.revision === revision);
      const rounds = [...new Set(inRevision.map((f) => f.round))].sort((a, b) => a - b);
      for (const round of rounds) {
        lines.push(`### Round ${String(round)}`, '');
        for (const f of inRevision.filter((x) => x.round === round)) {
          lines.push(`- ${f.reviewer}${f.severity === null ? '' : `, ${f.severity}`}: ${f.text}`);
          lines.push(`  - State: ${f.state}${f.outcome === null ? '' : ` (${f.outcome})`}`);
          if (f.how !== null) lines.push(`  - How: ${f.how}`);
        }
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

function questionsFile(record: PlanRecordForExport): string {
  const lines = ['# Questions', ''];
  for (const q of record.questions)
    lines.push(
      `- ${q.key} (for ${q.for}): ${q.text}${q.blocks === null ? '' : ` Blocks: ${q.blocks}.`} State: ${q.state}.`,
    );
  const open = record.decisions.filter((d) => d.decidedAt === null);
  if (open.length > 0) {
    lines.push('', '## Decisions still open', '');
    for (const d of open) lines.push(`- ${d.key}: ${d.question} Proposed: ${d.choice}.`);
  }
  lines.push('');
  return lines.join('\n');
}

/** The files of an export, README first; a document's file is its latest revision, nothing added. */
export function exportLayout(record: PlanRecordForExport): ExportFile[] {
  const rest: ExportFile[] = [
    ...record.documents.map((d) => ({ path: `documents/${d.key}.md`, text: d.body })),
    { path: 'entries.md', text: entriesFile(record) },
    { path: 'decisions.md', text: decisionsFile(record) },
    { path: 'reviews.md', text: reviewsFile(record) },
    { path: 'questions.md', text: questionsFile(record) },
  ];
  return [{ path: 'README.md', text: readme(record, rest) }, ...rest];
}
