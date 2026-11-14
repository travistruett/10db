import { KindDto, type KindId, type KindInput, type KindPatch } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

/** Every kind query; a `kind` event refetches them. */
export const KINDS_KEY = ['kinds'] as const;

const KindList = z.array(KindDto);

/** The kinds in the builder's order. */
export function useKinds() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: KINDS_KEY,
    queryFn: async () => readJson(await client.kinds.$get(), KindList),
  });
}

export function useCreateKind() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: KindInput) =>
      readJson(await client.kinds.$post({ json: input }), KindDto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KINDS_KEY }),
  });
}

/** Changes a kind's fields; its key never changes, and the contract refuses a patch that names one. */
export function usePatchKind() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly id: KindId; readonly patch: KindPatch }) =>
      readJson(
        await client.kinds[':kindId'].$patch({ param: { kindId: input.id }, json: input.patch }),
        KindDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KINDS_KEY }),
  });
}

export function useDeleteKind() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: KindId) => {
      // The answer is 204 with no body; a refusal throws with the daemon's message.
      await readJson(await client.kinds[':kindId'].$delete({ param: { kindId: id } }), z.unknown());
      await queryClient.invalidateQueries({ queryKey: KINDS_KEY });
    },
  });
}

/** Moves a kind to a place in the list: 0 is first, and past the end is last. */
export function useMoveKind() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly kindId: KindId; readonly position: number }) =>
      readJson(await client.kinds.order.$put({ json: input }), KindList),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KINDS_KEY }),
  });
}
