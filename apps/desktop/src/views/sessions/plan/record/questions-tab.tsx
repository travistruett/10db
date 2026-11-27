import type { PlanQuestionRow, ShapeId } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import type { DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { KnowledgeTable } from '../../../knowledge/knowledge-table';
import { PROPOSAL_STATE_LABELS } from './decisions-tab';
import { SearchFilter } from './record-filters';
import { NOT_NARROWED, useRecordPage } from './record-paging';
import { emptyLine, RecordListStates } from './record-states';
import { CodeSpans } from './code-spans';

// Questions: what the effort left open, the questions it asked and the decisions not yet decided, with
// who answers, what each is about and what it holds up.

const NO_SORT = { columnAccessor: 'text', direction: 'asc' } as const;

const dash = (value: string | null) => value ?? '—';

/** Questions list's column titles and widths, which its placeholder draws too. */
export const QUESTION_COLUMNS = {
  text: { title: 'Question' },
  for: { title: 'For', width: 140 },
  about: { title: 'About', width: 140 },
  blocks: { title: 'Blocks', width: 160 },
  state: { title: 'State', width: 120 },
} as const;

export function QuestionsTab({ shapeId }: { readonly shapeId: ShapeId }) {
  const [narrowing, setNarrowing] = useState(NOT_NARROWED);
  const { query, page, paging } = useRecordPage(shapeId, 'questions', narrowing);
  const columns: DataTableColumn<PlanQuestionRow>[] = [
    {
      accessor: 'text',
      ...QUESTION_COLUMNS.text,
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
      render: (q) => (
        <Stack gap={2}>
          <Text size="sm">
            <CodeSpans text={q.text} />
          </Text>
          {q.source === 'decision' ? (
            <Text size="xs" c="dimmed">
              Undecided decision
            </Text>
          ) : null}
        </Stack>
      ),
    },
    { accessor: 'for', ...QUESTION_COLUMNS.for, toggleable: true, render: (q) => dash(q.for) },
    {
      accessor: 'about',
      ...QUESTION_COLUMNS.about,
      toggleable: true,
      render: (q) => (
        <Text size="xs" ff="monospace">
          {dash(q.about)}
        </Text>
      ),
    },
    {
      accessor: 'blocks',
      ...QUESTION_COLUMNS.blocks,
      toggleable: true,
      render: (q) => dash(q.blocks),
    },
    {
      accessor: 'state',
      ...QUESTION_COLUMNS.state,
      toggleable: true,
      render: (q) => (
        <Text size="sm" c="dimmed">
          {PROPOSAL_STATE_LABELS[q.state]}
        </Text>
      ),
    },
  ];
  return (
    <RecordListStates
      columns={Object.values(QUESTION_COLUMNS)}
      query={query}
      what="questions"
      none={{ narrowed: narrowing.q.trim() !== '', text: 'No open questions.' }}
    >
      <KnowledgeTable
        label="Questions"
        storeKey="plan-record-questions"
        records={page?.rows ?? []}
        columns={columns}
        idOf={(q) => q.id}
        sort={NO_SORT}
        onSort={() => undefined}
        paging={paging}
        empty={emptyLine(
          query,
          narrowing.q.trim() !== '',
          'questions',
          'This Plan leaves no question open.',
        )}
      />
    </RecordListStates>
  );
}
