import { KnowledgeState } from '@10db/contracts';
import { ActionIcon, Alert, Badge, Group, Loader, Text } from '@mantine/core';
import { IconInfoCircle, IconSearchOff } from '@tabler/icons-react';
import type { KnowledgeListDto } from '@10db/contracts';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { STATE_COLORS, STATE_LABELS } from './knowledge-labels';

/** A current record needs no label; every other state is said, because History is what shows them. */
export function StateBadge({ state }: { readonly state: KnowledgeState }) {
  if (state === KnowledgeState.Current) return null;
  return (
    <Badge size="sm" variant="light" color={STATE_COLORS[state]}>
      {STATE_LABELS[state]}
    </Badge>
  );
}

/** Opens a record's provenance. */
export function TraceButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <ActionIcon
      variant="subtle"
      size="sm"
      aria-label={`Where ${label} came from`}
      onClick={onClick}
    >
      <IconInfoCircle size={16} stroke={1.5} />
    </ActionIcon>
  );
}

/**
 * What stands in for a list that has not arrived, failed, was cut short or is empty. Renders `children`
 * (the table) only when there are rows.
 */
export function ListStates({
  query,
  what,
  searching,
  empty,
  children,
}: {
  readonly query: UseQueryResult<KnowledgeListDto>;
  /** "principles" / "decisions", for the messages. */
  readonly what: string;
  readonly searching: boolean;
  readonly empty: string;
  readonly children: ReactNode;
}) {
  if (query.isError)
    return (
      <Alert color="red" title={`Couldn't load the ${what}`}>
        {query.error.message}
      </Alert>
    );
  if (query.isPending) return <Loader size="sm" aria-label={`Loading ${what}`} />;
  const { items, truncated, search } = query.data;
  return (
    <>
      {/* A damaged index clears only when 10db restarts, so it is a line, not an alert to act on. */}
      {!search.available ? (
        <Group gap={6} wrap="nowrap">
          <IconSearchOff size={16} stroke={1.5} />
          <Text size="xs" c="dimmed">
            {search.message ?? 'Search is unavailable.'}
          </Text>
        </Group>
      ) : null}
      {/* An empty answer to a search the index could not run is not "no match": the line above says why. */}
      {items.length === 0 && (search.available || !searching) ? (
        <Text c="dimmed">{searching ? `No ${what} match.` : empty}</Text>
      ) : null}
      {items.length > 0 ? children : null}
      {truncated ? (
        <Text size="xs" c="dimmed">
          More matched than are shown. Search or filter to narrow them.
        </Text>
      ) : null}
    </>
  );
}
