import {
  DoItBriefDto,
  DoItPreviewDto,
  DoItResult,
  type ChatId,
  type DoItRequest,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { chatKeys } from './chat-queries';
import { passKeys } from './pass-queries';
import { useDaemon } from './provider';

// Sessions spec §7.3 (Do it): the sheet's preview, the brief the chat's agent writes for it, and the hand-off.
// The preview lives under the chats' key, so a `chat` event (the agent's `write_brief`, a seal) refetches it.

export const doItKeys = {
  preview: (chatId: ChatId) => [...chatKeys.all, 'do-it', chatId] as const,
} as const;

/** How often the preview is read again while the agent is still writing the brief (its 60 s cutoff sends no event). */
export const BRIEF_REFRESH_MS = 4000;

/** What the sheet shows before Do It; read while the sheet is open. */
export function useDoItPreview(chatId: ChatId, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: doItKeys.preview(chatId),
    queryFn: async () =>
      readJson(await client.chats[':chatId']['do-it'].$get({ param: { chatId } }), DoItPreviewDto),
    enabled,
    // The folder and the git state change under a sheet that stays open; a stale offer is refused at submit anyway.
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.brief.writing === true ? BRIEF_REFRESH_MS : false,
  });
}

/** Asks the chat's agent for a brief (or takes the chat-so-far one at once, mid-turn). */
export function useAskBrief() {
  const { client } = useDaemon();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly chatId: ChatId; readonly draft?: string }) =>
      readJson(
        await client.chats[':chatId'].brief.$post({
          param: { chatId: input.chatId },
          json: input.draft === undefined ? {} : { draft: input.draft },
        }),
        DoItBriefDto,
      ),
    onSettled: (_brief, _error, input) =>
      queries.invalidateQueries({ queryKey: doItKeys.preview(input.chatId) }),
  });
}

/** Cancels the brief's turn, when it is still the brief's. */
export function useCancelBrief() {
  const { client } = useDaemon();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (chatId: ChatId) =>
      readJson(await client.chats[':chatId'].brief.$delete({ param: { chatId } }), DoItBriefDto),
    onSettled: (_brief, _error, chatId) =>
      queries.invalidateQueries({ queryKey: doItKeys.preview(chatId) }),
  });
}

/**
 * Hands the chat's work on. Rejects with the daemon's words, which the sheet shows beside Do It.
 * `onHandedOff` is the mutation's own callback, not `mutate`'s: the seal can drop the chat's tab, and
 * the sheet with it, before the answer comes, and only the mutation's callbacks still run then.
 */
export function useDoIt(onHandedOff: (result: DoItResult, request: DoItRequest) => void) {
  const { client } = useDaemon();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly chatId: ChatId; readonly request: DoItRequest }) =>
      readJson(
        await client.chats[':chatId']['do-it'].$post({
          param: { chatId: input.chatId },
          json: input.request,
        }),
        DoItResult,
      ),
    onSuccess: (result, input) => {
      onHandedOff(result, input.request);
    },
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: chatKeys.all });
      void queries.invalidateQueries({ queryKey: ['tasks'] });
      // A pass of one is a new live pass: its tab reads the list and must not find it missing.
      void queries.invalidateQueries({ queryKey: passKeys.all });
    },
  });
}
