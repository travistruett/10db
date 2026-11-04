import { KnowledgeItemKind } from '@10db/contracts';
import { Stack, Table, Text, VisuallyHidden } from '@mantine/core';
import {
  useKnowledgeDecisions,
  type KnowledgeFilter,
  type TracedRecord,
} from '../../daemon/knowledge-queries';
import { dateText, scopeText } from './knowledge-labels';
import { ListStates, StateBadge, TraceButton } from './record-cells';

/** Recorded decisions of the project in scope: newest first, or best match first with a search. */
export function DecisionList({
  filter,
  onTrace,
}: {
  readonly filter: KnowledgeFilter;
  readonly onTrace: (record: TracedRecord) => void;
}) {
  const decisions = useKnowledgeDecisions(filter);
  const rows = (decisions.data?.items ?? []).filter((i) => i.kind === KnowledgeItemKind.Decision);
  return (
    <ListStates
      query={decisions}
      what="decisions"
      searching={filter.q.trim() !== ''}
      empty="No decisions yet. Answers in the Inbox and the choices agents make on their own are recorded here."
    >
      <Table aria-label="Decisions" verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Decision</Table.Th>
            <Table.Th>Scope</Table.Th>
            <Table.Th>Date</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>
              <VisuallyHidden>Provenance</VisuallyHidden>
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((d) => (
            <Table.Tr key={d.id}>
              <Table.Td w="100%">
                <Stack gap={2}>
                  <Text size="sm" c="dimmed">
                    {d.question}
                  </Text>
                  <Text size="sm">{d.choice}</Text>
                  <Text size="xs" c="dimmed" lineClamp={2}>
                    {d.rationale}
                  </Text>
                </Stack>
              </Table.Td>
              <Table.Td>{scopeText(d)}</Table.Td>
              <Table.Td>{dateText(d.createdAt)}</Table.Td>
              <Table.Td>
                <StateBadge state={d.state} />
              </Table.Td>
              <Table.Td>
                <TraceButton
                  label={d.question}
                  onClick={() => {
                    onTrace({ kind: d.kind, id: d.id, label: d.question });
                  }}
                />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ListStates>
  );
}
