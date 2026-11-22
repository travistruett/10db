import type { PlanRecordPage } from '@10db/contracts';
import { Loader, Text } from '@mantine/core';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * What stands in for a list that has not arrived; otherwise the table, which says when it is empty or
 * why it failed in its body, so its header filters stay in reach to undo what was refused.
 */
export function RecordListStates({
  query,
  what,
  none,
  children,
}: {
  readonly query: UseQueryResult<PlanRecordPage>;
  readonly what: string;
  /** The Plan has none at all and nothing narrows the list: one dim line in place of an empty table. */
  readonly none?: { readonly narrowed: boolean; readonly text: string };
  readonly children: ReactNode;
}) {
  if (query.isPending) return <Loader size="sm" aria-label={`Loading ${what}`} />;
  if (none !== undefined && !none.narrowed && query.data?.total === 0)
    return (
      <Text size="sm" c="dimmed">
        {none.text}
      </Text>
    );
  return <>{children}</>;
}

/** A table's empty body: why the list failed, nothing matches a filter, or the Plan has none. */
export function emptyLine(
  query: UseQueryResult<PlanRecordPage>,
  narrowed: boolean,
  what: string,
  none: string,
): ReactNode {
  if (query.isError)
    return (
      <Text size="sm" c="red" role="alert">
        {`Couldn't load the ${what}: ${query.error.message}`}
      </Text>
    );
  return narrowed ? `No ${what} match.` : none;
}
