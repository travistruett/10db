import {
  TakeoverCommandDto,
  TakeoverDto,
  TakeoverPreviewDto,
  type ConversationId,
} from '@10db/contracts';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { chatKeys } from './chat-queries';
import { conversationKeys } from './conversation-queries';
import { folderKeys } from './project-folder-queries';
import { useDaemon } from './provider';

// Sessions spec §7.5: a chat continued in the builder's own terminal. The daemon moves the chat's state and
// says so with a `conversation` event; the calls here refetch what they changed without waiting for it.

export const takeoverKeys = {
  all: ['takeover'],
  preview: (conversationId: ConversationId) => ['takeover', 'preview', conversationId] as const,
  of: (conversationId: ConversationId) => ['takeover', 'of', conversationId] as const,
} as const;

async function refresh(queries: QueryClient): Promise<void> {
  await Promise.all([
    queries.invalidateQueries({ queryKey: chatKeys.all }),
    queries.invalidateQueries({ queryKey: conversationKeys.all }),
    queries.invalidateQueries({ queryKey: folderKeys.all }),
    queries.invalidateQueries({ queryKey: takeoverKeys.all }),
  ]);
}

/**
 * What Open in Terminal would do now: why it can't, and what the builder is told. Read when the popover
 * opens, and never kept: the answer follows the folder and the account.
 */
export function useTakeoverPreview(conversationId: ConversationId, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: takeoverKeys.preview(conversationId),
    queryFn: async () =>
      readJson(
        await client.conversations[':conversationId'].takeover.preview.$get({
          param: { conversationId },
        }),
        TakeoverPreviewDto,
      ),
    enabled,
    gcTime: 0,
  });
}

/** The terminal a chat is in, with what the builder was told; read while the chat is `taken_over`. */
export function useTakeover(conversationId: ConversationId, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: takeoverKeys.of(conversationId),
    queryFn: async () =>
      readJson(
        await client.conversations[':conversationId'].takeover.$get({ param: { conversationId } }),
        TakeoverDto,
      ),
    enabled,
    retry: false,
  });
}

/** Opens the chat in the builder's terminal; the answer carries the command with Copy the Command. */
export function useOpenTakeover() {
  const { client } = useDaemon();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: ConversationId) =>
      readJson(
        await client.conversations[':conversationId'].takeover.$post({ param: { conversationId } }),
        TakeoverDto,
      ),
    onSettled: () => refresh(queries),
  });
}

/** The command a chat that is in the terminal runs again, prepared afresh. */
export function useTakeoverCommand() {
  const { client } = useDaemon();
  return useMutation({
    mutationFn: async (conversationId: ConversationId) =>
      readJson(
        await client.conversations[':conversationId'].takeover.command.$post({
          param: { conversationId },
        }),
        TakeoverCommandDto,
      ),
  });
}

/** Gives the chat back to 10db; what was typed meanwhile then runs. */
export function useHandBack() {
  const { client } = useDaemon();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: ConversationId) => {
      // Typed as the 204 the route answers; a refusal still arrives as the daemon's own words.
      const res: Pick<Response, 'ok' | 'status' | 'json'> = await client.conversations[
        ':conversationId'
      ]['hand-back'].$post({
        param: { conversationId },
      });
      // A 204 has no body; a refusal reads as the daemon's own words.
      if (!res.ok) await readJson(res, z.never());
    },
    onSettled: () => refresh(queries),
  });
}
