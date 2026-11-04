import { KnowledgeItemKind, type PrincipleItem } from '@10db/contracts';
import { Code, Group, Stack, Table, Text, VisuallyHidden } from '@mantine/core';
import type { ReactNode } from 'react';
import { useKnowledgePrinciples, type KnowledgeFilter } from '../../daemon/knowledge-queries';
import type { TracedRecord } from '../../daemon/knowledge-queries';
import {
  dateText,
  PRINCIPLE_KIND_LABELS,
  PRINCIPLE_KIND_ORDER,
  scopeText,
} from './knowledge-labels';
import { ListStates, StateBadge, TraceButton } from './record-cells';

/** The principles of the project in scope: policies first, then heuristics and beliefs, as the context pack orders them. */
export function PrincipleList({
  filter,
  onTrace,
  actions,
}: {
  readonly filter: KnowledgeFilter;
  readonly onTrace: (record: TracedRecord) => void;
  /** The row's menu. */
  readonly actions: (principle: PrincipleItem) => ReactNode;
}) {
  const principles = useKnowledgePrinciples(filter);
  // A stable sort keeps the daemon's order (newest first, or best match first) within a kind. With a
  // search the best match leads, so the kind grouping is left out. Whether the rows answer a search is
  // read from the answer, not the filter: rows standing in for a pending answer keep their order.
  const searched = principles.data?.searched ?? false;
  const rows = (principles.data?.items ?? [])
    .filter((i) => i.kind === KnowledgeItemKind.Principle)
    .toSorted((a, b) =>
      searched
        ? 0
        : PRINCIPLE_KIND_ORDER.indexOf(a.principleKind) -
          PRINCIPLE_KIND_ORDER.indexOf(b.principleKind),
    );
  return (
    <ListStates
      query={principles}
      what="principles"
      empty="No principles yet. Agents propose them and you confirm them here or in the Inbox."
    >
      <Table aria-label="Principles" verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Principle</Table.Th>
            <Table.Th>Kind</Table.Th>
            <Table.Th>Scope</Table.Th>
            <Table.Th>Date</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>
              <VisuallyHidden>Provenance</VisuallyHidden>
            </Table.Th>
            <Table.Th>
              <VisuallyHidden>Actions</VisuallyHidden>
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((p) => (
            <Table.Tr key={p.id}>
              <Table.Td w="100%">
                <Stack gap={2}>
                  <Text size="sm">{p.statement}</Text>
                  <Group gap="xs">
                    <Code>{p.topicKey}</Code>
                    {p.rationale ? (
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {p.rationale}
                      </Text>
                    ) : null}
                  </Group>
                </Stack>
              </Table.Td>
              <Table.Td>{PRINCIPLE_KIND_LABELS[p.principleKind]}</Table.Td>
              <Table.Td>{scopeText(p)}</Table.Td>
              <Table.Td>{dateText(p.createdAt)}</Table.Td>
              <Table.Td>
                <StateBadge state={p.state} />
              </Table.Td>
              <Table.Td>
                <TraceButton
                  label={p.statement}
                  onClick={() => {
                    onTrace({ kind: p.kind, id: p.id, label: p.statement });
                  }}
                />
              </Table.Td>
              <Table.Td>{actions(p)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ListStates>
  );
}
