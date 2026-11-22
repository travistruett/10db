import {
  ShapeConvertError,
  ShapeConvertResult,
  ShapeFileDto,
  ShapeRehearseResult,
  ShapeOfDto,
  ShapeStartCountsDto,
  ShapeUndoAcceptResult,
  ShapeViewDto,
  type DecisionId,
  type PrincipleId,
  type GoalId,
  type MilestoneCut,
  type ProjectId,
  type ShapeAcceptId,
  type ShapeAttachmentId,
  type ShapeFindingId,
  type ShapeId,
  type ShapeProposalId,
  type TaskId,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { dataUrlOf } from './data-url';
import { goalKeys } from './goal-queries';
import { useDaemon } from './provider';

export const shapeKeys = {
  all: ['shapes'],
  list: (projectId: ProjectId) => ['shapes', 'list', projectId] as const,
  view: (shapeId: ShapeId) => ['shapes', 'view', shapeId] as const,
  /** The prefix of every Accept and Start count, so task and run events refetch them all. */
  startCountsAll: ['shapes', 'start-counts'],
  startCounts: (shapeId: ShapeId, proposalIds: readonly ShapeProposalId[]) =>
    ['shapes', 'start-counts', shapeId, [...proposalIds].sort()] as const,
} as const;

/** One conversation as the screen renders it: transcript, proposals, the heard echo and the turn. */
export function useShapeView(shapeId: ShapeId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: shapeId ? shapeKeys.view(shapeId) : ['shapes', 'view', 'none'],
    queryFn: async () =>
      shapeId
        ? readJson(await client.shapes[':shapeId'].$get({ param: { shapeId } }), ShapeViewDto)
        : Promise.reject(new Error('Open a conversation first.')),
    enabled: shapeId !== null,
  });
}

/**
 * A screenshot Plan took (§5.5), by the name its transcript row gives it, as a data URL. Kept pictures
 * never change, so one is read once; it is not under `shapeKeys.all`, which a `shape.changed` asks again.
 */
export function useShapeScreen(shapeId: ShapeId, name: string) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: ['shape-screens', shapeId, name] as const,
    queryFn: async (): Promise<string> => {
      const res = await client.shapes[':shapeId'].screens[':name'].$get({
        param: { shapeId, name },
      });
      if (!res.ok) throw new Error(`The daemon answered HTTP ${String(res.status)}`);
      return dataUrlOf(await res.blob());
    },
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}

/** What a goal's or task's drawer asks: the conversation that made it, if one did (§12). */
export type ShapeOfTarget = { readonly goalId: GoalId } | { readonly taskId: TaskId };

/**
 * The conversation that made a goal or a task, for its drawer's Open conversation; null when none
 * did. Under `shapeKeys.all`, so a Convert's `shape.changed` asks again.
 */
export function useShapeOf(target: ShapeOfTarget) {
  const { client } = useDaemon();
  const id = 'goalId' in target ? target.goalId : target.taskId;
  return useQuery({
    queryKey: ['shapes', 'of', id] as const,
    queryFn: async () =>
      'goalId' in target
        ? readJson(
            await client.goals[':goalId'].shape.$get({ param: { goalId: target.goalId } }),
            ShapeOfDto,
          )
        : readJson(
            await client.tasks[':taskId'].shape.$get({ param: { taskId: target.taskId } }),
            ShapeOfDto,
          ),
  });
}

/** The builder dismisses a reviewer's finding or a rehearsal question. */
export function useDismissFinding(shapeId: ShapeId | null) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly findingId: ShapeFindingId; readonly how?: string }) => {
      if (shapeId === null) throw new Error('Open a conversation first.');
      await readJson(
        await client.shapes[':shapeId'].findings[':findingId'].dismiss.$post({
          param: { shapeId, findingId: input.findingId },
          json: input.how === undefined ? {} : { how: input.how },
        }),
        z.null(),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}

/** Which review a press asks for: Plan review, Find Open Questions (the rehearsal), or Design review. */
export type ReviewKind = 'review' | 'rehearse' | 'design_review';

/**
 * Sends the session a review turn over every pending goal and task. The answer says whether a turn was
 * queued, one already runs, or there was nothing to read.
 */
export function useReviewShape(shapeId: ShapeId | null) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (kind: ReviewKind) => {
      if (shapeId === null) throw new Error('Open a conversation first.');
      const param = { shapeId };
      const res =
        kind === 'review'
          ? await client.shapes[':shapeId'].review.$post({ param, json: {} })
          : kind === 'rehearse'
            ? await client.shapes[':shapeId'].rehearse.$post({ param, json: {} })
            : await client.shapes[':shapeId']['design-review'].$post({ param, json: {} });
      return { kind, result: await readJson(res, ShapeRehearseResult) };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}

/** The builder approves a mock-up as the design target, or takes the approval back. */
export function useApproveAttachment(shapeId: ShapeId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      readonly attachmentId: ShapeAttachmentId;
      readonly approved: boolean;
    }) => {
      await readJson(
        await client.shapes[':shapeId'].attachments[':attachmentId'].approval.$post({
          param: { shapeId, attachmentId: input.attachmentId },
          json: { approved: input.approved },
        }),
        z.null(),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}

/** What Convert came to: the rows it made, or every reason it refused (nothing is written then). */
export type ConvertShapeResult =
  | { readonly kind: 'converted'; readonly result: ShapeConvertResult }
  | { readonly kind: 'refused'; readonly errors: readonly string[] };

/**
 * Converts the selected proposals into goals, tasks and decisions. A refusal is an answer, not a
 * failure: the modal lists it beside Convert. A turn still running (409) rejects with the daemon's words.
 */
export function useConvertShape(shapeId: ShapeId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      readonly proposalIds: readonly ShapeProposalId[];
      /** The builder's cut of a Plan with many milestones. */
      readonly cut?: readonly MilestoneCut[];
      /** Accept and Start: also starts what is ready. */
      readonly start?: boolean;
    }): Promise<ConvertShapeResult> => {
      const res = await client.shapes[':shapeId'].convert.$post({
        param: { shapeId },
        json: {
          proposalIds: [...input.proposalIds],
          ...(input.cut === undefined ? {} : { cut: [...input.cut] }),
          ...(input.start === true ? { start: true } : {}),
        },
      });
      if (res.status === 400) {
        const body: unknown = await res
          .clone()
          .json()
          .catch(() => null);
        const refusal = ShapeConvertError.safeParse(body);
        if (refusal.success) return { kind: 'refused', errors: refusal.data.errors };
      }
      return { kind: 'converted', result: await readJson(res, ShapeConvertResult) };
    },
    // Convert writes goals, tasks and decisions, whose own events refresh the Board and Factory.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}

/**
 * What Accept and Start would do with the ticked rows, for the confirm. Enabled only while the modal
 * is in start mode with at least one row; task and run events refetch it (`shapeKeys.startCountsAll`).
 */
export function useStartCounts(
  shapeId: ShapeId,
  proposalIds: readonly ShapeProposalId[],
  enabled: boolean,
) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: shapeKeys.startCounts(shapeId, proposalIds),
    queryFn: async () =>
      readJson(
        await client.shapes[':shapeId']['start-counts'].$get({
          param: { shapeId },
          query: { proposalIds: [...proposalIds].sort().join(',') },
        }),
        ShapeStartCountsDto,
      ),
    enabled: enabled && proposalIds.length > 0,
  });
}

/**
 * Undo Accept: takes back the plan's latest Accept. A refusal (400, 409) rejects with the daemon's words;
 * settled either way, the view is read again, so "Undo the later Accept first" shows the new latest one.
 */
export function useUndoAccept(shapeId: ShapeId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (acceptId: ShapeAcceptId) =>
      readJson(
        await client.shapes[':shapeId'].accepts[':acceptId'].undo.$post({
          param: { shapeId, acceptId },
        }),
        ShapeUndoAcceptResult,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}

/** Remove Draft Goal: allowed while every task of the goal is unstarted; its proposal is pending again. */
export function useRemoveDraftGoal() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (goalId: GoalId) => {
      await readJson(
        await client.goals[':goalId']['remove-draft'].$post({ param: { goalId } }),
        z.null(),
      );
    },
    // The goal and its tasks are gone, so the Board and Factory ask again alongside the conversation.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
        queryClient.invalidateQueries({ queryKey: goalKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      ]),
  });
}

/** The builder's actions on a proposal row (spec §6 Editing): each pins, unpins, restores or drops one row. */
export type RowChange =
  | { readonly kind: 'edit'; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly kind: 'unpin'; readonly field?: string }
  | { readonly kind: 'restore' }
  | { readonly kind: 'drop' };

export function useRowChange(shapeId: ShapeId | null) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly id: ShapeProposalId; readonly action: RowChange }) => {
      if (shapeId === null) throw new Error('Open a conversation first.');
      const param = { shapeId, proposalId: input.id };
      const row = client.shapes[':shapeId'].proposals[':proposalId'];
      const action = input.action;
      const res =
        action.kind === 'edit'
          ? await row.$patch({ param, json: { fields: { ...action.fields } } })
          : action.kind === 'unpin'
            ? await row.unpin.$post({
                param,
                json: action.field === undefined ? {} : { field: action.field },
              })
            : action.kind === 'restore'
              ? await row.restore.$post({ param })
              : await row.drop.$post({ param });
      await readJson(res, z.null());
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}

/** Drops a file into the conversation; the daemon's refusal (type, size, count) comes back as its words. */
export function useUploadShapeFile() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      shapeId,
      file,
    }: {
      readonly shapeId: ShapeId;
      readonly file: File;
    }): Promise<ShapeFileDto> => {
      return readJson(
        await client.shapes[':shapeId'].files.$post(
          { param: { shapeId }, query: { name: file.name } },
          {
            headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
            init: { body: file },
          },
        ),
        ShapeFileDto,
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}

/** Withdraw Principle: a tombstone with the builder's reason; the principle leaves searches and context. */
export function useWithdrawPrinciple(shapeId: ShapeId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly principleId: PrincipleId; readonly reason: string }) => {
      await readJson(
        await client.shapes[':shapeId'].principles[':principleId'].withdraw.$post({
          param: { shapeId, principleId: input.principleId },
          json: { reason: input.reason },
        }),
        z.null(),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}

/** Withdraw Decision: a tombstone with the builder's reason; the decision leaves searches and context. */
export function useWithdrawDecision(shapeId: ShapeId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly decisionId: DecisionId; readonly reason: string }) => {
      await readJson(
        await client.shapes[':shapeId'].decisions[':decisionId'].withdraw.$post({
          param: { shapeId, decisionId: input.decisionId },
          json: { reason: input.reason },
        }),
        z.null(),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}
