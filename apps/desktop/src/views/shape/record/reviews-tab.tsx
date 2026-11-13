import {
  ShapeFindingSeverity,
  ShapeFindingState,
  type PlanReviewGroup,
  type PlanReviewRow,
  type ShapeId,
} from '@10db/contracts';
import { Badge, Group, Stack, Text } from '@mantine/core';
import type { DataTableColumn } from 'mantine-datatable';
import { useState, type ReactNode } from 'react';
import { KnowledgeTable } from '../../knowledge/knowledge-table';
import { ANY, ChoiceFilter, SearchFilter } from './record-filters';
import { NOT_NARROWED, useRecordPage } from './record-paging';
import { emptyLine, RecordListStates } from './record-states';

// Reviews: every finding of the effort, grouped by the document, revision and round it was made on,
// each in its reviewer's own words, with the outcome as the effort wrote it.

const STATE_LABELS: Readonly<Record<ShapeFindingState, string>> = {
  [ShapeFindingState.Open]: 'Open',
  [ShapeFindingState.Resolved]: 'Resolved',
  [ShapeFindingState.Dismissed]: 'Dismissed',
};

const STATE_OPTIONS = Object.values(ShapeFindingState).map((value) => ({
  value,
  label: STATE_LABELS[value],
}));

const SEVERITY_COLORS: Readonly<Record<ShapeFindingSeverity, string>> = {
  [ShapeFindingSeverity.High]: 'red',
  [ShapeFindingSeverity.Medium]: 'yellow',
  [ShapeFindingSeverity.Low]: 'gray',
};

/** "p1 · revision 1 · round 1 · 9 high, 13 low", counted over the whole filtered list. */
export function groupLine(group: PlanReviewGroup): string {
  const counts = (['high', 'medium', 'low'] as const)
    .filter((s) => group[s] > 0)
    .map((s) => `${String(group[s])} ${s}`);
  const unrated = group.total - group.high - group.medium - group.low;
  if (unrated > 0) counts.push(`${String(unrated)} questions`);
  return [
    group.document,
    group.revision === null ? null : `revision ${String(group.revision)}`,
    `round ${String(group.round)}`,
    counts.join(', '),
  ]
    .filter((part) => part !== null && part !== '')
    .join(' · ');
}

type Line =
  | { readonly kind: 'group'; readonly id: string; readonly group: PlanReviewGroup }
  | { readonly kind: 'finding'; readonly id: string; readonly row: PlanReviewRow };

const groupId = (g: { document: string; revision: number | null; round: number }): string =>
  `${g.document}\u0000${String(g.revision)}\u0000${String(g.round)}`;

/** A page's rows with a header line before the first row of each group on it. */
export function linesOf(
  rows: readonly PlanReviewRow[],
  groups: readonly PlanReviewGroup[],
): Line[] {
  const byId = new Map(groups.map((g) => [groupId(g), g]));
  const lines: Line[] = [];
  let last: string | null = null;
  for (const row of rows) {
    const id = groupId(row);
    const group = byId.get(id);
    if (id !== last && group !== undefined) lines.push({ kind: 'group', id: `group:${id}`, group });
    last = id;
    lines.push({ kind: 'finding', id: row.id, row });
  }
  return lines;
}

const NO_SORT = { columnAccessor: 'reviewer', direction: 'asc' } as const;

export function ReviewsTab({
  shapeId,
  documents,
}: {
  readonly shapeId: ShapeId;
  /** The Plan's document keys, for the Document filter. */
  readonly documents: readonly string[];
}) {
  const [narrowing, setNarrowing] = useState(NOT_NARROWED);
  const { query, page, paging } = useRecordPage(shapeId, 'reviews', narrowing);
  const narrowed =
    narrowing.q.trim() !== '' || narrowing.state !== ANY || narrowing.document !== ANY;
  const finding = (render: (row: PlanReviewRow) => ReactNode) => (line: Line) =>
    line.kind === 'finding' ? render(line.row) : null;
  const columns: DataTableColumn<Line>[] = [
    {
      accessor: 'reviewer',
      title: 'Reviewer',
      width: 180,
      resizable: true,
      render: (line) =>
        line.kind === 'group' ? (
          <Text size="sm" fw={600} c="bright" style={{ whiteSpace: 'nowrap' }}>
            {groupLine(line.group)}
          </Text>
        ) : (
          <Text size="sm">{line.row.reviewer}</Text>
        ),
    },
    {
      accessor: 'document',
      title: 'Document',
      width: 140,
      toggleable: true,
      filtering: narrowing.document !== ANY,
      filter: (
        <ChoiceFilter
          label="Document"
          value={narrowing.document}
          options={documents.map((key) => ({ value: key, label: key }))}
          onChange={(document) => {
            setNarrowing({ ...narrowing, document });
          }}
        />
      ),
      render: finding((row) => (
        <Text size="xs" ff="monospace" c="dimmed">
          {row.section === null ? row.document : `${row.document}#${row.section}`}
        </Text>
      )),
    },
    {
      accessor: 'severity',
      title: 'Severity',
      width: 170,
      toggleable: true,
      render: finding((row) => (
        <Group gap={6} wrap="nowrap">
          {row.severity === null ? null : (
            <Badge
              size="sm"
              variant="light"
              color={SEVERITY_COLORS[row.severity]}
              style={{ flex: 'none' }}
            >
              {row.severity}
            </Badge>
          )}
          {row.severityText === null ? null : <Text size="xs">{row.severityText}</Text>}
        </Group>
      )),
    },
    {
      accessor: 'text',
      title: 'Finding',
      resizable: true,
      filtering: narrowing.q.trim() !== '',
      filter: (
        <SearchFilter
          value={narrowing.q}
          onChange={(q) => {
            setNarrowing({ ...narrowing, q });
          }}
        />
      ),
      render: finding((row) => (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {row.text}
        </Text>
      )),
    },
    {
      accessor: 'outcome',
      title: 'Outcome',
      resizable: true,
      toggleable: true,
      render: finding((row) => (
        <Stack gap={2}>
          {row.outcomeText === null ? null : <Text size="sm">{row.outcomeText}</Text>}
          {/* How it was closed, then the detail of it; either may be there without the other. */}
          {[row.how, row.howDetail].map((line, i) =>
            line === null || line === '' ? null : (
              <Text key={i} size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                {line}
              </Text>
            ),
          )}
        </Stack>
      )),
    },
    {
      accessor: 'state',
      title: 'State',
      width: 120,
      toggleable: true,
      filtering: narrowing.state !== ANY,
      filter: (
        <ChoiceFilter
          label="State"
          value={narrowing.state}
          options={STATE_OPTIONS}
          onChange={(state) => {
            setNarrowing({ ...narrowing, state });
          }}
        />
      ),
      render: finding((row) => (
        <Text size="sm" c="dimmed">
          {STATE_LABELS[row.state]}
        </Text>
      )),
    },
  ];
  return (
    <RecordListStates query={query} what="reviews">
      <KnowledgeTable
        label="Reviews"
        storeKey="plan-record-reviews"
        records={linesOf(page?.rows ?? [], page?.groups ?? [])}
        columns={columns}
        idOf={(line) => line.id}
        sort={NO_SORT}
        onSort={() => undefined}
        paging={paging}
        empty={emptyLine(narrowed, 'findings', 'This Plan records no reviews.')}
      />
    </RecordListStates>
  );
}
