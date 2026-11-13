import type { PlanQuestionRow, ShapeId } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import type { DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { KnowledgeTable } from '../../knowledge/knowledge-table';
import { PROPOSAL_STATE_LABELS } from './decisions-tab';
import { SearchFilter } from './record-filters';
import { NOT_NARROWED, useRecordPage } from './record-paging';
import { emptyLine, RecordListStates } from './record-states';

// Questions: what the effort left open, the questions it asked and the decisions not yet decided, with
// who answers, what each is about and what it holds up.

const NO_SORT = { columnAccessor: 'text', direction: 'asc' } as const;

const dash = (value: string | null) => value ?? '—';

export function QuestionsTab({ shapeId }: { readonly shapeId: ShapeId }) {
  const [narrowing, setNarrowing] = useState(NOT_NARROWED);
  const { query, page, paging } = useRecordPage(shapeId, 'questions', narrowing);
  const columns: DataTableColumn<PlanQuestionRow>[] = [
    {
      accessor: 'text',
      title: 'Question',
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
          <Text size="sm">{q.text}</Text>
          {q.source === 'decision' ? (
            <Text size="xs" c="dimmed">
              Undecided decision
            </Text>
          ) : null}
        </Stack>
      ),
    },
    { accessor: 'for', title: 'For', width: 140, toggleable: true, render: (q) => dash(q.for) },
    {
      accessor: 'about',
      title: 'About',
      width: 140,
      toggleable: true,
      render: (q) => (
        <Text size="xs" ff="monospace">
          {dash(q.about)}
        </Text>
      ),
    },
    {
      accessor: 'blocks',
      title: 'Blocks',
      width: 160,
      toggleable: true,
      render: (q) => dash(q.blocks),
    },
    {
      accessor: 'state',
      title: 'State',
      width: 120,
      toggleable: true,
      render: (q) => (
        <Text size="sm" c="dimmed">
          {PROPOSAL_STATE_LABELS[q.state]}
        </Text>
      ),
    },
  ];
  return (
    <RecordListStates query={query} what="questions">
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
          narrowing.q.trim() !== '',
          'questions',
          'This Plan leaves no question open.',
        )}
      />
    </RecordListStates>
  );
}
