import {
  PlanDocumentRevisionDto,
  PlanExportResult,
  PlanRecordDto,
  PlanRecordPage,
  type PlanRecordList,
  type PlanRecordPageSize,
  type PlanRecordQuery,
  type ShapeId,
} from '@10db/contracts';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useRenderMode } from '../screens/render-context';
import { readJson } from './client';
import { useDaemon } from './provider';

// A Plan's record. Every key is under `shapeKeys.all` (`['shapes']`), so `plan.record_changed`, whose
// entity is the Plan, refetches it.

export const planRecordKeys = {
  record: (shapeId: ShapeId) => ['shapes', 'record', shapeId] as const,
  revision: (shapeId: ShapeId, key: string, number: number) =>
    ['shapes', 'record', shapeId, 'revision', key, number] as const,
  page: (shapeId: ShapeId, list: PlanRecordList, filters: PlanRecordFilters) =>
    ['shapes', 'record', shapeId, 'page', list, filters] as const,
} as const;

/** What a list is narrowed by and which page of it is shown; the daemon applies all of it. */
export interface PlanRecordFilters {
  readonly state?: NonNullable<PlanRecordQuery['state']>;
  readonly kind?: NonNullable<PlanRecordQuery['kind']>;
  readonly document?: string;
  readonly q?: string;
  readonly page: number;
  readonly pageSize: PlanRecordPageSize;
}

/**
 * The record: documents with every revision and their sections, and each list's count. A screen's
 * frame never asks, since its token may not read the record and the refusal would fail the screen.
 */
export function usePlanRecord(shapeId: ShapeId | null) {
  const { client } = useDaemon();
  const frame = useRenderMode() !== null;
  return useQuery({
    queryKey: shapeId ? planRecordKeys.record(shapeId) : ['shapes', 'record', 'none'],
    queryFn: async () =>
      shapeId
        ? readJson(
            await client.shapes[':shapeId'].record.$get({ param: { shapeId } }),
            PlanRecordDto,
          )
        : Promise.reject(new Error('Open a Plan first.')),
    enabled: shapeId !== null && !frame,
  });
}

/** One revision's text, as stored. A revision never changes, so it is read once. */
export function usePlanRevision(shapeId: ShapeId, key: string | null, number: number | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey:
      key !== null && number !== null
        ? planRecordKeys.revision(shapeId, key, number)
        : ['shapes', 'record', shapeId, 'revision', 'none'],
    queryFn: async () => {
      if (key === null || number === null) throw new Error('Pick a document first.');
      return readJson(
        await client.shapes[':shapeId'].documents[':key'].revisions[':number'].$get({
          param: { shapeId, key, number: String(number) },
        }),
        PlanDocumentRevisionDto,
      );
    },
    enabled: key !== null && number !== null,
    staleTime: Infinity,
  });
}

/** One page of one list; the last page stays up while the next loads. */
export function usePlanRecordPage(
  shapeId: ShapeId,
  list: PlanRecordList,
  filters: PlanRecordFilters,
) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: planRecordKeys.page(shapeId, list, filters),
    queryFn: async () =>
      readJson(
        await client.shapes[':shapeId'].record[':list'].$get({
          param: { shapeId, list },
          query: {
            ...(filters.state === undefined ? {} : { state: filters.state }),
            ...(filters.kind === undefined ? {} : { kind: filters.kind }),
            ...(filters.document === undefined ? {} : { document: filters.document }),
            ...(filters.q === undefined || filters.q.trim() === '' ? {} : { q: filters.q }),
            page: String(filters.page),
            pageSize: String(filters.pageSize),
          },
        }),
        PlanRecordPage,
      ),
    placeholderData: keepPreviousData,
  });
}

/** Writes the record as Markdown into a folder; the daemon's refusal is the error's message. */
export function useExportPlan(shapeId: ShapeId) {
  const { client } = useDaemon();
  return useMutation({
    mutationFn: async (dir: string) =>
      readJson(
        await client.shapes[':shapeId'].export.$post({ param: { shapeId }, json: { dir } }),
        PlanExportResult,
      ),
  });
}
