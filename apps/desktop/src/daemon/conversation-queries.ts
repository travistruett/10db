import {
  ConversationDto,
  ConversationFullDto,
  ConversationItemDto,
  ConversationItemsPage,
  ConversationLiveDto,
  type ConversationDeltaFrame,
  type ConversationId,
  type ConversationItemId,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { applyFrame, liveItemsOf, type LiveItems } from '../conversation/live-items';
import { readJson } from './client';
import { useDaemon } from './provider';
import { shapeKeys } from './shape-queries';

// Sessions spec §10: one conversation as the UI reads it, whoever owns it. Its stored items and its
// state follow the `conversation` events; what streams now is a live store fed by the socket's
// frames (`writeLiveFrame`) and read again from `/live` when it opens, reconnects or finds a gap.

export const conversationKeys = {
  all: ['conversations'],
  one: (id: ConversationId) => ['conversations', id] as const,
  items: (id: ConversationId) => ['conversations', id, 'items'] as const,
} as const;

/** Apart from `conversationKeys`, so a stored item's event refetches the items, not the stream. */
export const liveKeys = {
  all: ['conversation-live'],
  one: (id: ConversationId) => ['conversation-live', id] as const,
} as const;

const NO_ITEMS: readonly ConversationItemDto[] = [];
const NO_LIVE: LiveItems = new Map();

/** The conversation's state, capabilities and queue. */
export function useConversation(id: ConversationId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: id === null ? ['conversations', 'none'] : conversationKeys.one(id),
    queryFn: async () =>
      id === null
        ? Promise.reject(new Error('No conversation'))
        : readJson(
            await client.conversations[':conversationId'].$get({ param: { conversationId: id } }),
            ConversationDto,
          ),
    enabled: id !== null,
  });
}

/** Every stored item of the conversation, in `seq` order, read a page at a time. */
export function useConversationItems(id: ConversationId | null): readonly ConversationItemDto[] {
  const { client } = useDaemon();
  const query = useQuery({
    queryKey: id === null ? ['conversations', 'none', 'items'] : conversationKeys.items(id),
    queryFn: async () => {
      if (id === null) return [];
      const items: ConversationItemDto[] = [];
      let afterSeq: number | null = null;
      for (;;) {
        const page: ConversationItemsPage = await readJson(
          await client.conversations[':conversationId'].items.$get({
            param: { conversationId: id },
            query: afterSeq === null ? {} : { afterSeq },
          }),
          ConversationItemsPage,
        );
        items.push(...page.items);
        if (page.nextAfterSeq === null) return items;
        afterSeq = page.nextAfterSeq;
      }
    },
    enabled: id !== null,
  });
  return query.data ?? NO_ITEMS;
}

/** The ids the conversation has stored, whose frames are stale. */
function storedIds(queryClient: QueryClient, id: ConversationId): ReadonlySet<ConversationItemId> {
  const items = queryClient.getQueryData<readonly ConversationItemDto[]>(
    conversationKeys.items(id),
  );
  return new Set(items?.map((item) => item.id));
}

/**
 * The frames that arrived while each `/live` read was on its way, per client and conversation. A
 * read's answer is a moment before it lands; the frames since are applied to it again, which by
 * absolute offset adds only what it lacks.
 */
const arriving = new WeakMap<QueryClient, Map<ConversationId, Set<ConversationDeltaFrame[]>>>();

function arrivingFor(queryClient: QueryClient, id: ConversationId): Set<ConversationDeltaFrame[]> {
  let byConversation = arriving.get(queryClient);
  if (byConversation === undefined) {
    byConversation = new Map();
    arriving.set(queryClient, byConversation);
  }
  let reads = byConversation.get(id);
  if (reads === undefined) {
    reads = new Set();
    byConversation.set(id, reads);
  }
  return reads;
}

/** Applies a live frame to what the conversation streams; a gap reads `/live` again. */
export function writeLiveFrame(queryClient: QueryClient, frame: ConversationDeltaFrame): void {
  const id = frame.conversationId;
  for (const read of arriving.get(queryClient)?.get(id) ?? []) read.push(frame);
  const key = liveKeys.one(id);
  const held = queryClient.getQueryData<LiveItems>(key);
  // Nothing on screen streams this conversation: its next read has the frame.
  if (held === undefined) return;
  const { items, gap } = applyFrame(held, frame, storedIds(queryClient, id));
  if (gap) {
    void queryClient.invalidateQueries({ queryKey: key });
    return;
  }
  if (items !== held) queryClient.setQueryData(key, items);
}

/** What the conversation streams now: replies, thinking and calls in flight, by item id. */
export function useConversationLive(id: ConversationId | null): LiveItems {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: id === null ? ['conversation-live', 'none'] : liveKeys.one(id),
    queryFn: async (): Promise<LiveItems> => {
      if (id === null) return NO_LIVE;
      const read: ConversationDeltaFrame[] = [];
      const reads = arrivingFor(queryClient, id);
      reads.add(read);
      let snapshot: ConversationLiveDto;
      try {
        snapshot = await readJson(
          await client.conversations[':conversationId'].live.$get({
            param: { conversationId: id },
          }),
          ConversationLiveDto,
        );
      } finally {
        reads.delete(read);
      }
      // An item that finished since the last read is stored by now: the items are read first, so it
      // never leaves the screen between the two.
      const before = queryClient.getQueryData<LiveItems>(liveKeys.one(id));
      const still = new Set(snapshot.items.map((item) => item.itemId));
      const stored = storedIds(queryClient, id);
      if ([...(before?.keys() ?? [])].some((itemId) => !still.has(itemId) && !stored.has(itemId)))
        await queryClient.refetchQueries({ queryKey: conversationKeys.items(id), exact: true });
      let items = liveItemsOf(snapshot);
      for (const frame of read) items = applyFrame(items, frame, storedIds(queryClient, id)).items;
      return items;
    },
    enabled: id !== null,
  });
  return query.data ?? NO_LIVE;
}

/** Invalidates what a builder's action on a conversation changes: it, its items, and Plan's views. */
async function refreshAfter(queryClient: QueryClient, id: ConversationId): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: conversationKeys.one(id) }),
    queryClient.invalidateQueries({ queryKey: shapeKeys.all }),
  ]);
}

/** What the builder sends a conversation: words, the files its `@` mentions name, and pictures. */
export interface ConversationMessageSend {
  readonly conversationId: ConversationId;
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly pictures?: readonly File[];
}

/** The request body: JSON for words alone, a multipart form when pictures go with them. */
function messageRequest({ text, mentions = [], pictures = [] }: ConversationMessageSend) {
  if (pictures.length === 0)
    return {
      headers: { 'content-type': 'application/json' },
      init: { body: JSON.stringify(mentions.length === 0 ? { text } : { text, mentions }) },
    };
  const form = new FormData();
  form.append('text', text);
  for (const path of mentions) form.append('mention', path);
  for (const picture of pictures) form.append('picture', picture, picture.name);
  // No content type: the form's own carries the boundary.
  return { init: { body: form } };
}

/** Sends the builder's message; the conversation's owner queues its turn. */
export function useSendConversationMessage() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConversationMessageSend) =>
      readJson(
        await client.conversations[':conversationId'].messages.$post(
          { param: { conversationId: input.conversationId } },
          messageRequest(input),
        ),
        ConversationItemDto,
      ),
    onSuccess: (_item, input) => refreshAfter(queryClient, input.conversationId),
  });
}

/** Stops the turn that runs; answers once the stop has been asked for. */
export function useStopConversation() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: ConversationId) =>
      readJson(
        await client.conversations[':conversationId'].stop.$post({ param: { conversationId } }),
        ConversationDto,
      ),
    onSuccess: (_dto, conversationId) => refreshAfter(queryClient, conversationId),
  });
}

/** Sends what waits under the Send now line; refused with the daemon's words when nothing would run. */
export function useSendNow() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: ConversationId) =>
      readJson(
        await client.conversations[':conversationId']['send-now'].$post({
          param: { conversationId },
        }),
        ConversationDto,
      ),
    onSuccess: (_dto, conversationId) => refreshAfter(queryClient, conversationId),
  });
}

/**
 * Reads a tool call's whole output or patch from disk, by the adapter's call id as the kit gives it.
 * What is kept on disk never changes, so each is read once.
 */
export function useToolCallFull(
  conversationId: ConversationId | null,
  items: readonly ConversationItemDto[],
): (callId: string) => Promise<string> {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useCallback(
    async (callId: string) => {
      const item = items.find((i) => i.kind === 'tool_call' && i.call.id === callId);
      if (conversationId === null || item === undefined)
        throw new Error('This call has nothing more kept.');
      const full = await queryClient.query({
        queryKey: ['conversation-full', conversationId, item.id] as const,
        queryFn: async () =>
          readJson(
            await client.conversations[':conversationId'].items[':itemId'].full.$get({
              param: { conversationId, itemId: item.id },
            }),
            ConversationFullDto,
          ),
        staleTime: Infinity,
      });
      return full.output ?? full.patch ?? full.text ?? '';
    },
    [client, conversationId, items, queryClient],
  );
}
