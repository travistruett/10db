import {
  KnowledgeScope,
  KnowledgeState,
  type ProposalDto,
  type ProposalKind,
} from '@10db/contracts';
import { Alert, Loader, Stack, Table, Text, VisuallyHidden } from '@mantine/core';
import type { ReactNode } from 'react';
import { useProposals } from '../../daemon/knowledge-queries';
import type { FilterState } from './knowledge-filters';
import { dateText, PRINCIPLE_KIND_LABELS, scopeText } from './knowledge-labels';
import { StateBadge } from './record-cells';

const KIND_LABELS: Readonly<Record<ProposalKind, string>> = {
  new_task: 'Task',
  change_task: 'Task change',
  principle: 'Principle',
  note: 'Note',
};

/** A principle proposal is for a place; any other proposal is about the project. */
function placeOf(p: ProposalDto): { scope: KnowledgeScope; area: string | null } {
  return p.principle ?? { scope: KnowledgeScope.Project, area: null };
}

/** Search and scope narrow pending proposals the way they narrow the lists; History has no meaning for them. */
function matches(p: ProposalDto, filter: FilterState): boolean {
  const place = placeOf(p);
  if (filter.scope !== null && place.scope !== filter.scope) return false;
  if (filter.scope === KnowledgeScope.Area && place.area !== filter.area) return false;
  const words = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = [p.title, p.body, p.principle?.statement, p.principle?.topicKey]
    .join(' ')
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Pending proposals. Their text comes from agents and answers, so it is shown as text only. */
export function ProposalList({
  projectId,
  filter,
  actions,
}: {
  readonly projectId: ProposalDto['projectId'];
  readonly filter: FilterState;
  /** Accept and Reject for a proposal. */
  readonly actions: (proposal: ProposalDto) => ReactNode;
}) {
  const proposals = useProposals(projectId);
  if (proposals.isError)
    return (
      <Alert color="red" title="Couldn't load the proposals">
        {proposals.error.message}
      </Alert>
    );
  if (proposals.isPending) return <Loader size="sm" aria-label="Loading proposals" />;
  const rows = proposals.data.filter((p) => matches(p, filter));
  if (rows.length === 0)
    return (
      <Text c="dimmed">
        {proposals.data.length === 0 ? 'No proposals wait for you.' : 'No proposal matches.'}
      </Text>
    );
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        Accept or reject a proposal here or in the Inbox; either closes its card.
      </Text>
      <Table aria-label="Proposals" verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Proposal</Table.Th>
            <Table.Th>Kind</Table.Th>
            <Table.Th>Scope</Table.Th>
            <Table.Th>Date</Table.Th>
            <Table.Th>State</Table.Th>
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
                  <Text size="sm" fw={500}>
                    {p.title}
                  </Text>
                  {p.principle ? <Text size="sm">{p.principle.statement}</Text> : null}
                  <Text size="xs" c="dimmed" lineClamp={3} style={{ whiteSpace: 'pre-wrap' }}>
                    {p.body}
                  </Text>
                </Stack>
              </Table.Td>
              <Table.Td>
                {p.principle ? PRINCIPLE_KIND_LABELS[p.principle.kind] : KIND_LABELS[p.kind]}
              </Table.Td>
              <Table.Td>{scopeText(placeOf(p))}</Table.Td>
              <Table.Td>{dateText(p.createdAt)}</Table.Td>
              <Table.Td>
                <StateBadge state={KnowledgeState.Proposed} />
              </Table.Td>
              <Table.Td>{actions(p)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
