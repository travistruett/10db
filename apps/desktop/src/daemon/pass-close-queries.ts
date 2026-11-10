import {
  PassCloseAnswerDto,
  PassClosePreviewDto,
  PassPullRequestDto,
  PassPullRequestPreviewDto,
  PassSignOff,
  PassSignOffDto,
  PassState,
  TakeOutPreviewDto,
  TaskMessageDto,
  type InboxItemId,
  type PassCloseRequest,
  type PassId,
  type PassViewDto,
  type TaskId,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
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

/** What Take Out… asks about first: the page's shared changes that have not landed. */
export function useTakeOutPreview({ passId, taskId }: PassPage) {
  const { client } = useDaemon();
  return useQuery({
    // Not under `passKeys.all`: the take-out it leads to refetches the passes, and a page gone from the
    // pass has nothing to preview. Kept nowhere once the confirm closes, so each Take Out… reads it
    // afresh and never offers a Drop from an earlier read.
    queryKey: ['take-out-preview', passId, taskId],
    staleTime: 0,
    gcTime: 0,
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
  const { client } = useDaemon();
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
  const { client } = useDaemon();
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
  const { client } = useDaemon();
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

/**
 * What Open Pull Request would do, read before it is offered and only while the pass is open. It
 * reads git, so it is not under `passKeys.all`: it is read again when what it answers can change, a
 * page signed off or the pull request made, and after an open.
 */
export function usePullRequestPreview(view: PassViewDto) {
  const { client } = useDaemon();
  const passId = view.pass.id;
  const signedOff = view.pages.filter((page) => page.signOff === PassSignOff.Done).length;
  return useQuery({
    queryKey: [...pullRequestPreviewKey(passId), signedOff, view.pullRequest?.url ?? null],
    enabled: view.pass.state === PassState.Open,
    // While a sign-off reads it again, the same pass's last answer stays, so an open confirm stays
    // open until the new answer says otherwise; another pass's answer never stands in.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === passId ? previous : undefined,
    queryFn: async () =>
      readJson(
        await client.passes[':passId']['pull-request'].$get({ param: { passId } }),
        PassPullRequestPreviewDto,
      ),
  });
}

/** Every read of a pass's pull request preview. */
function pullRequestPreviewKey(passId: PassId) {
  return ['pass-pull-request', passId] as const;
}

/** Open Pull Request: pushes the signed-off pages and opens a draft, or updates the one open. */
export function useOpenPullRequest() {
  const { client } = useDaemon();
  const refetch = useRefetchPasses();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (passId: PassId) =>
      readJson(
        await client.passes[':passId']['pull-request'].$post({ param: { passId } }),
        PassPullRequestDto,
      ),
    onSuccess: (_opened, passId) =>
      Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: pullRequestPreviewKey(passId) }),
      ]),
  });
}

/**
 * What Close Pass… shows: the lists a close settles, read once per opening. It stops nothing (D25).
 * Not under `passKeys.all`: the close it leads to refetches the passes, and a closing pass has no lists.
 */
export function useClosePreview(passId: PassId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: ['close-preview', passId],
    // Kept nowhere once the modal closes: each Close Pass… shows the lists as they are now.
    staleTime: 0,
    gcTime: 0,
    queryFn: async () =>
      readJson(
        await client.passes[':passId'].close.$get({ param: { passId } }),
        PassClosePreviewDto,
      ),
  });
}

/** Close Pass: closes on the lists confirmed, or answers them again with what changed. */
export function useClosePass() {
  const { client } = useDaemon();
  const refetch = useRefetchPasses();
  return useMutation({
    mutationFn: async ({ passId, request }: { passId: PassId; request: PassCloseRequest }) =>
      readJson(
        await client.passes[':passId'].close.$post({ param: { passId }, json: request }),
        PassCloseAnswerDto,
      ),
    onSuccess: refetch,
  });
}
