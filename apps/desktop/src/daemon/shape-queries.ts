import {
  ShapeConvertError,
  ShapeConvertResult,
  ShapeDto,
  ShapeMessageDto,
  ShapeProposeResult,
  ShapeViewDto,
  type DecisionId,
  type GoalId,
  type ProjectId,
  type ShapeId,
  type ShapeProposalId,
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
    mutationFn: async (proposalIds: readonly ShapeProposalId[]): Promise<ConvertShapeResult> => {
      const res = await client.shapes[':shapeId'].convert.$post({
        param: { shapeId },
        json: { proposalIds: [...proposalIds] },
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
