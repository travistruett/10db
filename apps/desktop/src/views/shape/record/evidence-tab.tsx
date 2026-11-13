import {
  PlanEntryBody,
  PlanEntryKind,
  PlanEntryState,
  type PlanEvidenceRow,
  type ShapeId,
} from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import type { DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import { KnowledgeTable } from '../../knowledge/knowledge-table';
import { AnchorBadge } from './anchor-badge';
import { anchorPlace, anchorStatuses } from './anchor-status';
import { ANY, ChoiceFilter, SearchFilter } from './record-filters';
import { NOT_NARROWED, useRecordPage } from './record-paging';
import { emptyLine, RecordListStates } from './record-states';

// Evidence: the builder's words, the facts with where each was read, the experiments and the names.
// Each code anchor shows each task's newest check of it, and only a check that found it at its line
// reads Current.

export const ENTRY_KIND_LABELS: Readonly<Record<PlanEntryKind, string>> = {
  [PlanEntryKind.Intent]: 'Intent',
  [PlanEntryKind.Fact]: 'Fact',
  [PlanEntryKind.Experiment]: 'Experiment',
  [PlanEntryKind.Name]: 'Name',
};

const KIND_OPTIONS = Object.values(PlanEntryKind).map((value) => ({
  value,
  label: ENTRY_KIND_LABELS[value],
}));

// An entry that stands is not called Current, which is the word for an anchor found at its line.
const STATE_LABELS: Readonly<Record<PlanEntryState, string>> = {
  [PlanEntryState.Current]: 'Stands',
  [PlanEntryState.Superseded]: 'Superseded',
};

const STATE_OPTIONS = Object.values(PlanEntryState).map((value) => ({
  value,
  label: STATE_LABELS[value],
}));

/** An entry's one line: the quote, the claim, what an experiment shows, or a name's definition. */
export function entryLine(entry: Pick<PlanEvidenceRow, 'kind' | 'body'>): string | null {
  switch (entry.kind) {
    case PlanEntryKind.Intent: {
      const body = PlanEntryBody.intent.safeParse(entry.body);
      return body.success ? `“${body.data.quote}” (${body.data.speaker})` : null;
    }
    case PlanEntryKind.Fact: {
      const body = PlanEntryBody.fact.safeParse(entry.body);
      if (!body.success) return null;
      return 'claim' in body.data
        ? body.data.claim
        : (body.data.note ?? `Cost over ${String(body.data.rows.length)} phases`);
    }
    case PlanEntryKind.Experiment: {
      const body = PlanEntryBody.experiment.safeParse(entry.body);
      return body.success ? body.data.shows : null;
    }
    case PlanEntryKind.Name: {
      const body = PlanEntryBody.name.safeParse(entry.body);
      return body.success ? `${body.data.name}: ${body.data.definition}` : null;
    }
  }
}

const NO_SORT = { columnAccessor: 'title', direction: 'asc' } as const;

function Anchors({ entry }: { readonly entry: PlanEvidenceRow }) {
  if (entry.anchors.length === 0)
    return (
      <Text size="xs" c="dimmed">
        None
      </Text>
    );
  return (
    <Stack gap={6}>
      {entry.anchors.map((anchor, index) => (
        <Stack key={`${String(index)}:${anchorPlace(anchor)}`} gap={2}>
          <Text size="xs" ff="monospace" truncate>
            {anchorPlace(anchor)}
          </Text>
          {anchorStatuses(anchor, index, entry.checks).map(({ taskId, title, status }) => (
            <AnchorBadge
              key={taskId ?? 'none'}
              status={status}
              task={title}
              dimmed={entry.state === PlanEntryState.Superseded}
            />
          ))}
        </Stack>
      ))}
    </Stack>
  );
}

export function EvidenceTab({ shapeId }: { readonly shapeId: ShapeId }) {
  const [narrowing, setNarrowing] = useState(NOT_NARROWED);
  const { query, page, paging } = useRecordPage(shapeId, 'evidence', narrowing);
  const narrowed = narrowing.q.trim() !== '' || narrowing.kind !== ANY || narrowing.state !== ANY;
  const columns: DataTableColumn<PlanEvidenceRow>[] = [
    {
      accessor: 'kind',
      title: 'Kind',
      width: 130,
      filtering: narrowing.kind !== ANY,
      filter: (
        <ChoiceFilter
          label="Kind"
          value={narrowing.kind}
          options={KIND_OPTIONS}
          onChange={(kind) => {
            setNarrowing({ ...narrowing, kind });
          }}
        />
      ),
      render: (e) => ENTRY_KIND_LABELS[e.kind],
    },
    {
      accessor: 'title',
      title: 'Title',
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
      render: (e) => {
        const intent =
          e.kind === PlanEntryKind.Intent ? PlanEntryBody.intent.safeParse(e.body) : null;
        // The builder's words are the row: a title made from them would only say them twice.
        if (intent?.success)
          return (
            <Stack gap={2}>
              <Text size="sm" lineClamp={4} style={{ whiteSpace: 'pre-wrap' }}>
                {intent.data.quote}
              </Text>
              <Text size="xs" c="dimmed">{`${intent.data.speaker} · ${intent.data.saidAt}`}</Text>
            </Stack>
          );
        return (
          <Stack gap={2}>
            <Text size="sm">{e.title}</Text>
            <Text size="xs" c="dimmed" lineClamp={3} style={{ whiteSpace: 'pre-wrap' }}>
              {entryLine(e)}
            </Text>
          </Stack>
        );
      },
    },
    {
      accessor: 'anchors',
      title: 'Anchors',
      resizable: true,
      toggleable: true,
      render: (e) => <Anchors entry={e} />,
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
      render: (e) => (
        <Text size="sm" c="dimmed">
          {STATE_LABELS[e.state]}
        </Text>
      ),
    },
    {
      accessor: 'verified',
      title: 'Verified',
      width: 100,
      toggleable: true,
      render: (e) => (e.verified ? 'Yes' : 'No'),
    },
    {
      accessor: 'checkedAt',
      title: 'Checked',
      width: 120,
      noWrap: true,
      toggleable: true,
      render: (e) => e.checkedAt ?? '—',
    },
  ];
  return (
    <RecordListStates query={query} what="evidence">
      <KnowledgeTable
        label="Evidence"
        storeKey="plan-record-evidence"
        records={page?.rows ?? []}
        columns={columns}
        idOf={(e) => e.key}
        sort={NO_SORT}
        onSort={() => undefined}
        paging={paging}
        empty={emptyLine(query, narrowed, 'entries', 'This Plan records no evidence.')}
      />
    </RecordListStates>
  );
}
