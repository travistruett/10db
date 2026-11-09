import { Alert, Badge, Group, Loader, Text } from '@mantine/core';
import { IconSearchOff } from '@tabler/icons-react';
import type { KnowledgeState } from '@10db/contracts';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { KnowledgeAnswer } from '../../daemon/knowledge-queries';
import { STATE_COLORS, STATE_LABELS } from './knowledge-labels';

/** Every state is said, Current too: a decision has no kind, so this badge is all a row says about it. */
export function StateBadge({ state }: { readonly state: KnowledgeState }) {
  return (
    <Badge size="sm" variant="light" color={STATE_COLORS[state]}>
      {STATE_LABELS[state]}
    </Badge>
  );
}

/**
 * What a list says in its body when no row is shown. A search the index could not run says nothing:
 * the line `ListStates` draws above says why.
 */
export function emptyText(
  answer: KnowledgeAnswer | undefined,
  what: string,
  empty: string,
  narrowed: boolean,
): string {
  if (answer && !answer.search.available && answer.searched) return '';
  return (answer?.searched ?? false) || narrowed ? `No ${what} match.` : empty;
}

/**
 * What stands in for a list that has not arrived or failed, and the lines around it when search is
 * unavailable or the answer was cut short. Otherwise it draws `children`, the table, which says itself
 * when it is empty so its filters stay in reach.
 */
export function ListStates({
  query,
  what,
  children,
}: {
  readonly query: UseQueryResult<KnowledgeAnswer>;
  /** "principles" / "decisions", for the messages. */
  readonly what: string;
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
  // An empty answer to the previous filter says nothing about the new one: wait for it rather than
  // claim that nothing exists or nothing matched.
  if (query.isPlaceholderData && items.length === 0)
    return <Loader size="sm" aria-label={`Loading ${what}`} />;
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
      {children}
      {truncated ? (
        <Text size="xs" c="dimmed">
          More matched than are shown. Search or filter to narrow them.
        </Text>
      ) : null}
    </>
  );
}
