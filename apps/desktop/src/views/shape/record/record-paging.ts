import {
  PLAN_RECORD_PAGE_SIZES,
  PlanRecordQuery,
  type PlanRecordList,
  type PlanRecordPage,
  type PlanRecordPageSize,
  type ShapeId,
} from '@10db/contracts';
import { useDebouncedValue } from '@mantine/hooks';
import type { UseQueryResult } from '@tanstack/react-query';
import { usePlanRecordPage } from '../../../daemon/plan-record-queries';
import type { TablePage } from '../../knowledge/knowledge-table';
import { usePaging } from '../../knowledge/knowledge-paging';
import { ANY } from './record-filters';

// One list of the Record a page at a time: the filters and search go to the daemon, and the page goes
// back to the first whenever they change.

export interface RecordNarrowing {
  readonly state: string;
  readonly kind: string;
  readonly document: string;
  readonly q: string;
}

export const NOT_NARROWED: RecordNarrowing = { state: ANY, kind: ANY, document: ANY, q: '' };

const pageSizeOf = (n: number): PlanRecordPageSize =>
  PLAN_RECORD_PAGE_SIZES.find((size) => size === n) ?? 25;

/** Whether a page is of `list`: an answer from before the list changed is not. */
function isList<L extends PlanRecordList>(
  page: PlanRecordPage,
  list: L,
): page is Extract<PlanRecordPage, { list: L }> {
  return page.list === list;
}

/** The page asked for, the answer and the pager's props. */
export function useRecordPage<L extends PlanRecordList>(
  shapeId: ShapeId,
  list: L,
  narrowing: RecordNarrowing,
): {
  readonly query: UseQueryResult<PlanRecordPage>;
  readonly page: Extract<PlanRecordPage, { list: L }> | undefined;
  readonly paging: TablePage;
} {
  const [q] = useDebouncedValue(narrowing.q.trim(), 250);
  const asked = { ...narrowing, q };
  const paging = usePaging(JSON.stringify(asked));
  // A filter's choices are the contract's own values, read back through it.
  const state = PlanRecordQuery.shape.state.safeParse(asked.state);
  const kind = PlanRecordQuery.shape.kind.safeParse(asked.kind);
  const query = usePlanRecordPage(shapeId, list, {
    ...(state.success && state.data !== undefined ? { state: state.data } : {}),
    ...(kind.success && kind.data !== undefined ? { kind: kind.data } : {}),
    ...(asked.document === ANY ? {} : { document: asked.document }),
    ...(q === '' ? {} : { q }),
    page: paging.page,
    pageSize: pageSizeOf(paging.pageSize),
  });
  const page = query.data !== undefined && isList(query.data, list) ? query.data : undefined;
  return {
    query,
    page,
    paging: { ...paging, total: page?.total ?? 0, page: page?.page ?? paging.page },
  };
}
