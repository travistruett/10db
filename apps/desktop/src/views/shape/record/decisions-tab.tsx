import { ShapeProposalState, type PlanDecisionRow, type ShapeId } from '@10db/contracts';
import { Drawer, List, Stack, Text } from '@mantine/core';
import type { DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { KnowledgeTable } from '../../knowledge/knowledge-table';
import { ANY, ChoiceFilter, SearchFilter } from './record-filters';
import { NOT_NARROWED, useRecordPage } from './record-paging';
import { emptyLine, RecordListStates } from './record-states';
import { CodeSpans } from './code-spans';

// Decisions: what the effort decided and what it turned down. A row opens its rationale, the options
// turned down and the builder's own words.

export const PROPOSAL_STATE_LABELS: Readonly<Record<ShapeProposalState, string>> = {
  [ShapeProposalState.Pending]: 'Pending',
  [ShapeProposalState.Accepted]: 'Accepted',
  [ShapeProposalState.Rejected]: 'Rejected',
  [ShapeProposalState.Superseded]: 'Superseded',
};

const STATE_OPTIONS = Object.values(ShapeProposalState).map((value) => ({
  value,
  label: PROPOSAL_STATE_LABELS[value],
}));

/** Lasting decisions outlive the effort and reach Knowledge at Convert; the rest hold for this effort. */
export const lastingText = (lasting: boolean): string => (lasting ? 'Lasting' : 'This effort');

const NO_SORT = { columnAccessor: 'question', direction: 'asc' } as const;

function DecisionDrawer({
  decision,
  onClose,
}: {
  readonly decision: PlanDecisionRow | null;
  readonly onClose: () => void;
}) {
  return (
    <Drawer
      opened={decision !== null}
      onClose={onClose}
      position="right"
      size="min(560px, 50vw)"
      title={decision?.question}
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      {decision === null ? null : (
        <Stack gap="md">
          <Text size="sm" fw={500}>
            <CodeSpans text={decision.choice} />
          </Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            <CodeSpans text={decision.rationale} />
          </Text>
          {decision.alternatives.length === 0 ? null : (
            <List size="sm" spacing={4}>
              {decision.alternatives.map((a) => (
                <List.Item key={a.option}>{`Turned down: ${a.option} — ${a.whyNot}`}</List.Item>
              ))}
            </List>
          )}
          {decision.quote === null ? null : (
            <Text size="sm" c="dimmed" fs="italic" style={{ whiteSpace: 'pre-wrap' }}>
              {`“${decision.quote}”`}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {[
              lastingText(decision.lasting),
              decision.decidedAt === null ? 'Not decided yet' : `Decided ${decision.decidedAt}`,
              PROPOSAL_STATE_LABELS[decision.state],
            ].join(' · ')}
          </Text>
        </Stack>
      )}
    </Drawer>
  );
}

export function DecisionsTab({ shapeId }: { readonly shapeId: ShapeId }) {
  const [narrowing, setNarrowing] = useState(NOT_NARROWED);
  const [open, setOpen] = useState<PlanDecisionRow | null>(null);
  const { query, page, paging } = useRecordPage(shapeId, 'decisions', narrowing);
  const narrowed = narrowing.q.trim() !== '' || narrowing.state !== ANY;
  const columns: DataTableColumn<PlanDecisionRow>[] = [
    {
      accessor: 'question',
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
      render: (d) => (
        <Text size="sm">
          <CodeSpans text={d.question} />
        </Text>
      ),
    },
    {
      accessor: 'choice',
      title: 'Choice',
      resizable: true,
      toggleable: true,
      render: (d) => (
        <Text size="sm" lineClamp={2}>
          <CodeSpans text={d.choice} />
        </Text>
      ),
    },
    {
      accessor: 'lasting',
      title: 'Lasting',
      width: 120,
      toggleable: true,
      render: (d) => lastingText(d.lasting),
    },
    {
      accessor: 'decidedAt',
      title: 'Decided',
      width: 120,
      noWrap: true,
      toggleable: true,
      render: (d) => d.decidedAt ?? 'Not yet',
    },
    {
      accessor: 'state',
      title: 'State',
      width: 130,
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
      render: (d) => (
        <Text size="sm" c="dimmed">
          {PROPOSAL_STATE_LABELS[d.state]}
        </Text>
      ),
    },
  ];
  return (
    <RecordListStates query={query} what="decisions">
      <KnowledgeTable
        label="Decisions"
        storeKey="plan-record-decisions"
        records={page?.rows ?? []}
        columns={columns}
        idOf={(d) => d.id}
        onOpen={setOpen}
        sort={NO_SORT}
        onSort={() => undefined}
        paging={paging}
        empty={emptyLine(narrowed, 'decisions', 'This Plan records no decisions.')}
      />
      <DecisionDrawer
        decision={open}
        onClose={() => {
          setOpen(null);
        }}
      />
    </RecordListStates>
  );
}
