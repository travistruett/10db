import type { PlanRecordPage } from '@10db/contracts';
import { Alert, Loader } from '@mantine/core';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** What stands in for a list that has not arrived or failed; otherwise the table, which says when it is empty. */
export function RecordListStates({
  query,
  what,
  children,
}: {
  readonly query: UseQueryResult<PlanRecordPage>;
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
  return <>{children}</>;
}

/** A table's empty body: nothing matches a filter, or the Plan has none. */
export const emptyLine = (narrowed: boolean, what: string, none: string): string =>
  narrowed ? `No ${what} match.` : none;
