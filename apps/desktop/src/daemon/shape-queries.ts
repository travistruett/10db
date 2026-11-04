import {
  ShapeConvertError,
  ShapeConvertResult,
  ShapeDto,
  ShapeFileDto,
  ShapeMessageDto,
  ShapeOfDto,
  ShapeProposeResult,
  ShapeRehearseResult,
  ShapeViewDto,
  type DecisionId,
  type PrincipleId,
  type GoalId,
  type ProjectId,
  type ShapeFindingId,
  type ShapeId,
  type ShapeProposalId,
  type TaskId,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

export const shapeKeys = {
  all: ['shapes'],
  list: (projectId: ProjectId) => ['shapes', 'list', projectId] as const,
  view: (shapeId: ShapeId) => ['shapes', 'view', shapeId] as const,
} as const;

/** The project's conversations, the most recently updated first. */
export function useShapes(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectId ? shapeKeys.list(projectId) : ['shapes', 'none'],
    queryFn: async () =>
      projectId
        ? readJson(
            await client.projects[':projectId'].shapes.$get({ param: { projectId } }),
            z.array(ShapeDto),
          )
        : [],
    enabled: projectId !== null,
  });
}

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

/** Opens a conversation. The title is the daemon's to set from the first message. */
export function useCreateShape(projectId: ProjectId | null) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<ShapeDto> => {
      if (!projectId) throw new Error('Choose a project first.');
      return readJson(
        await client.projects[':projectId'].shapes.$post({ param: { projectId }, json: {} }),
        ShapeDto,
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}

/** Sends the builder's message; the daemon queues Claude's turn behind any turn that is running. */
export function useSendShapeMessage() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly shapeId: ShapeId; readonly text: string }) =>
      readJson(
        await client.shapes[':shapeId'].messages.$post({
          param: { shapeId: input.shapeId },
          json: { text: input.text },
        }),
        ShapeMessageDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}

/** Propose, or Propose Again: a press while a Propose turn is queued or running is ignored. */
export function useProposeShape() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (shapeId: ShapeId) =>
      readJson(
        await client.shapes[':shapeId'].propose.$post({ param: { shapeId } }),
        ShapeProposeResult,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}

/** Interrupts the turn that is running; the queue runs next. */
export function useStopShape() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (shapeId: ShapeId) => {
      await readJson(await client.shapes[':shapeId'].stop.$post({ param: { shapeId } }), z.null());
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  });
}

/**
 * Rehearse (§7): the session has the rehearsal reviewer read each proposed task with no mark at its
 * current content. Opening the Convert modal asks for it too, for the proposals about to be converted.
 */
export function useRehearseShape(shapeId: ShapeId | null) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (proposalIds?: readonly ShapeProposalId[]) => {
      if (shapeId === null) throw new Error('Open a conversation first.');
      return readJson(
        await client.shapes[':shapeId'].rehearse.$post({
          param: { shapeId },
          json: proposalIds === undefined ? {} : { proposalIds: [...proposalIds] },
        }),
        ShapeRehearseResult,
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
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
    // `interrupt` is Convert Anyway: it stops the turn that is running instead of answering 409 (§7).
    mutationFn: async (input: {
      readonly proposalIds: readonly ShapeProposalId[];
      readonly interrupt?: boolean;
    }): Promise<ConvertShapeResult> => {
      const res = await client.shapes[':shapeId'].convert.$post({
        param: { shapeId },
        json: {
          proposalIds: [...input.proposalIds],
          ...(input.interrupt === true ? { interrupt: true } : {}),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
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

/** Withdraw Principle…: a tombstone with the builder's reason; the principle leaves searches and context. */
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

/** Withdraw Decision…: a tombstone with the builder's reason; the decision leaves searches and context. */
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
