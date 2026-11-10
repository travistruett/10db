import {
  PassSignOffDto,
  TakeOutPreviewDto,
  TaskMessageDto,
  type InboxItemId,
  type PassId,
  type TaskId,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { createPassCloseRoutesClient } from './pass-close-routes';
import { passKeys } from './pass-queries';
import { useDaemon } from './provider';
import { queryKeys } from './queries';
import { threadKeys } from './thread-queries';

// Workbench spec §5.4, §8.3, §9.2: how a pass's pages are signed off and taken out, and how the pass
// opens its pull request and closes. Each mutation reads the passes again once it lands, as the pass
// events would.

/** A page of a pass, as the routes that act on one name it. */
export interface PassPage {
  readonly passId: PassId;
  readonly taskId: TaskId;
}

/** A mutation that reads the passes, the Inbox and the tasks again once it lands. */
function useRefetchPasses() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [passKeys.all, queryKeys.inbox, ['tasks']].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
}

/** The typed client of the routes `AppType` does not declare yet, over this window's connection. */
function usePassCloseClient() {
  return createPassCloseRoutesClient(useDaemon().connection);
}

/** What Take Out… asks about first: the page's shared changes that have not landed. */
export function useTakeOutPreview({ passId, taskId }: PassPage) {
  const client = usePassCloseClient();
  return useQuery({
    // Not under `passKeys.all`: the take-out it leads to refetches the passes, and a page gone from the
    // pass has nothing to preview. Each Take Out… reads it afresh, and the daemon refuses a Drop no
    // longer offered.
    queryKey: ['take-out-preview', passId, taskId],
    staleTime: 0,
    queryFn: async () =>
      readJson(
        await client.passes[':passId'].tasks[':taskId']['take-out'].$get({
          param: { passId, taskId },
        }),
        TakeOutPreviewDto,
      ),
  });
}

/** Sign Off: the page lands now, or waits for the turn whose shared change it needs. */
export function useSignOff() {
  const client = usePassCloseClient();
  const refetch = useRefetchPasses();
  return useMutation({
    mutationFn: async ({ passId, taskId }: PassPage) =>
      readJson(
        await client.passes[':passId'].tasks[':taskId']['sign-off'].$post({
          param: { passId, taskId },
        }),
        PassSignOffDto,
      ),
    onSuccess: refetch,
  });
}

/** Cancel Sign-Off: a sign-off that waits for another page's turn is withdrawn; the page is Ready again. */
export function useCancelSignOff() {
  const client = usePassCloseClient();
  const refetch = useRefetchPasses();
  return useMutation({
    mutationFn: async ({ passId, taskId }: PassPage) =>
      readJson(
        await client.passes[':passId'].tasks[':taskId']['sign-off'].$delete({
          param: { passId, taskId },
        }),
        z.null(),
      ),
    onSuccess: refetch,
  });
}

/**
 * Send to Agent: a sendable notice's text goes to the page the builder picked, as the builder's own
 * message. `noticeId` is a header notice's id or a thread notice's message id.
 */
export function useSendToAgent() {
  const client = usePassCloseClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, noticeId }: { taskId: TaskId; noticeId: string }) =>
      readJson(
        await client.tasks[':taskId'].thread[':messageId']['send-to-agent'].$post({
          // A header notice's id may hold a path; the client puts params into the path as given.
          param: { taskId, messageId: encodeURIComponent(noticeId) },
        }),
        TaskMessageDto,
      ),
    onSuccess: (_message, { taskId }) =>
      Promise.all(
        [passKeys.all, threadKeys.of(taskId)].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
  });
}

/** Answers a card a pass raised (Retarget, Move) with its one choice, through the built Inbox route. */
export function useAnswerPassCard() {
  const { client } = useDaemon();
  const refetch = useRefetchPasses();
  return useMutation({
    mutationFn: async ({ itemId, choice }: { itemId: InboxItemId; choice: string }) =>
      readJson(
        await client.inbox[':id'].answer.$post({ param: { id: itemId }, json: { choice } }),
        z.unknown(),
      ),
    onSuccess: refetch,
  });
}
