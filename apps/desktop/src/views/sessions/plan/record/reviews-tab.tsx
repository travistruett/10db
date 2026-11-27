import {
  ShapeFindingSeverity,
  ShapeFindingState,
  type PlanReviewGroup,
  type PlanReviewRow,
  type ShapeId,
} from '@10db/contracts';
import { Button, Group, Stack, Text } from '@mantine/core';
import { useDismissFinding } from '../../../../daemon/shape-queries';
import type { DataTableColumn } from 'mantine-datatable';
import { useState, type ReactNode } from 'react';
import { KnowledgeTable } from '../../../knowledge/knowledge-table';
import { ANY, ChoiceFilter, SearchFilter } from './record-filters';
import { NOT_NARROWED, useRecordPage } from './record-paging';
import { emptyLine, RecordListStates } from './record-states';
import { CodeSpans } from './code-spans';

// Review Notes: every finding of the effort, grouped by what it reviewed (named by its title) and the
// review, each in its reviewer's own words, with the outcome once there is one. An open note can be
// dismissed here, or handed back to the session to fix.

const STATE_LABELS: Readonly<Record<ShapeFindingState, string>> = {
  [ShapeFindingState.Open]: 'Open',
  [ShapeFindingState.Resolved]: 'Resolved',
  [ShapeFindingState.Dismissed]: 'Dismissed',
};

const STATE_OPTIONS = Object.values(ShapeFindingState).map((value) => ({
  value,
  label: STATE_LABELS[value],
}));

const SEVERITY_LABELS: Readonly<Record<ShapeFindingSeverity, string>> = {
  [ShapeFindingSeverity.High]: 'High',
  [ShapeFindingSeverity.Medium]: 'Medium',
  [ShapeFindingSeverity.Low]: 'Low',
};

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * "An empty Done column says what goes in it · revision 1 · second review · 9 high, 13 low", counted
 * over the whole filtered list; what it reviewed is named by its title when the Plan has one for it.
 */
export function groupLine(
  group: PlanReviewGroup,
  titles: ReadonlyMap<string, string> = new Map(),
): string {
  const counts = (['high', 'medium', 'low'] as const)
    .filter((s) => group[s] > 0)
    .map((s) => `${String(group[s])} ${s}`);
  const unrated = group.total - group.high - group.medium - group.low;
  if (unrated > 0) counts.push(`${String(unrated)} questions`);
  return [
    titles.get(group.document) ?? group.document,
    group.revision === null ? null : `revision ${String(group.revision)}`,
    // The first review needs no number; a later one says which it was.
    group.round <= 1 ? null : `review ${String(group.round)}`,
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

/** Reviews list's column titles and widths, which its placeholder draws too. */
export const REVIEW_COLUMNS = {
  reviewer: { title: 'Reviewer', width: 110 },
  severity: { title: 'Severity', width: 90 },
  text: { title: 'Note' },
  outcome: { title: 'Outcome' },
  state: { title: 'State', width: 90 },
  actions: { title: '', width: 190 },
} as const;

export function ReviewsTab({
  shapeId,
  titles,
  onAskToFix,
}: {
  readonly shapeId: ShapeId;
  /** The Plan's row titles by key, so a group is named by what it reviewed. */
  readonly titles: ReadonlyMap<string, string>;
  /** Ask to Fix: hands the note to the session as the start of the builder's reply. */
  readonly onAskToFix: (text: string) => void;
}) {
  const [narrowing, setNarrowing] = useState(NOT_NARROWED);
  const dismiss = useDismissFinding(shapeId);
  const { query, page, paging } = useRecordPage(shapeId, 'reviews', narrowing);
  // Outcome is shown once a note on the page has one.
  const hasOutcome = (page?.rows ?? []).some(
    (row) => row.outcomeText !== null || row.how !== null || row.howDetail !== null,
  );
  const narrowed =
    narrowing.q.trim() !== '' || narrowing.state !== ANY || narrowing.document !== ANY;
  const finding = (render: (row: PlanReviewRow) => ReactNode) => (line: Line) =>
    line.kind === 'finding' ? render(line.row) : null;
  const columns: DataTableColumn<Line>[] = [
    {
      accessor: 'reviewer',
      ...REVIEW_COLUMNS.reviewer,
      resizable: true,
      render: (line) =>
        line.kind === 'group' ? (
          <Text size="sm" fw={600} c="bright" style={{ whiteSpace: 'nowrap' }}>
            {groupLine(line.group, titles)}
          </Text>
        ) : (
          <Text size="sm">{capital(line.row.reviewer)}</Text>
        ),
    },
    {
      accessor: 'severity',
      ...REVIEW_COLUMNS.severity,
      toggleable: true,
      render: finding((row) => (
        <Stack gap={2}>
          {row.severity === null ? null : (
            <Text size="sm" c="dimmed">
              {SEVERITY_LABELS[row.severity]}
            </Text>
          )}
          {row.severityText === null ? null : <Text size="xs">{row.severityText}</Text>}
        </Stack>
      )),
    },
    {
      accessor: 'text',
      ...REVIEW_COLUMNS.text,
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
          <CodeSpans text={row.text} />
        </Text>
      )),
    },
    {
      accessor: 'outcome',
      ...REVIEW_COLUMNS.outcome,
      resizable: true,
      toggleable: true,
      hidden: !hasOutcome,
      render: finding((row) => (
        <Stack gap={2}>
          {row.outcomeText === null ? null : (
            <Text size="sm">
              <CodeSpans text={row.outcomeText} />
            </Text>
          )}
          {/* How it was closed, then the detail of it; either may be there without the other. */}
          {[row.how, row.howDetail].map((line, i) =>
            line === null || line === '' ? null : (
              <Text key={i} size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                <CodeSpans text={line} />
              </Text>
            ),
          )}
        </Stack>
      )),
    },
    {
      accessor: 'state',
      ...REVIEW_COLUMNS.state,
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
    {
      accessor: 'actions',
      ...REVIEW_COLUMNS.actions,
      // An open note is acted on here: settled by Dismiss, or handed to the session by Ask to Fix.
      render: finding((row) =>
        row.state !== ShapeFindingState.Open ? null : (
          <Group gap={4} wrap="nowrap" justify="flex-end">
            <Button
              variant="subtle"
              color="gray"
              size="compact-xs"
              loading={dismiss.isPending && dismiss.variables.findingId === row.id}
              aria-label={`Dismiss: ${row.text}`}
              onClick={() => {
                dismiss.mutate({ findingId: row.id });
              }}
            >
              Dismiss
            </Button>
            <Button
              variant="light"
              size="compact-xs"
              aria-label={`Ask to fix: ${row.text}`}
              onClick={() => {
                onAskToFix(`Please address this review note: ${row.text}`);
              }}
            >
              Ask to Fix
            </Button>
          </Group>
        ),
      ),
    },
  ];
  return (
    <RecordListStates
      columns={Object.values(REVIEW_COLUMNS)}
      query={query}
      what="reviews"
      none={{ narrowed, text: 'No review notes yet. Ask for a review from ⋯ on the Plan.' }}
    >
      <KnowledgeTable
        label="Review Notes"
        storeKey="plan-record-reviews"
        records={linesOf(page?.rows ?? [], page?.groups ?? [])}
        columns={columns}
        idOf={(line) => line.id}
        sort={NO_SORT}
        onSort={() => undefined}
        paging={paging}
        empty={emptyLine(
          query,
          narrowed,
          'findings',
          'No review notes yet. Ask for a review from ⋯ on the Plan.',
        )}
      />
    </RecordListStates>
  );
}
