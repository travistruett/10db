import { InboxListState, type InboxAnswer, type InboxItemDto } from '@10db/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DaemonRequestError } from '../../daemon/client';
import { dropCard, refreshCard } from '../../daemon/inbox-live';
import { fetchRowOf } from '../../daemon/inbox-queries';
import { useDaemon } from '../../daemon/provider';
import { queryKeys, useAnswerInbox } from '../../daemon/queries';

export interface CardAnswer {
  readonly respond: (answer: InboxAnswer) => void;
  readonly pending: boolean;
  /** The answer's failure in words, or "This card was already answered." when it was; null otherwise. */
  readonly failure: string | null;
}

/**
 * Answering a card that its own buttons answer (acceptance, check, plan, look): the answer, the card leaving
 * the list once it lands, and a 409 that turns out to be an answer made elsewhere. `onAnswered` clears what
 * the holder kept for the card, such as its Send Back draft. Without `onAnsweredElsewhere` the card says so
 * itself.
 */
export function useCardAnswer(
  item: InboxItemDto,
  {
    onAnswered,
    onAnsweredElsewhere,
  }: { readonly onAnswered?: () => void; readonly onAnsweredElsewhere?: (() => void) | undefined },
): CardAnswer {
  const answer = useAnswerInbox();
  const queryClient = useQueryClient();
  const { client } = useDaemon();
  const [stale, setStale] = useState(false);

  const respond = (given: InboxAnswer): void => {
    setStale(false);
    answer.mutate(
      { id: item.id, answer: given },
      {
        onSuccess: () => {
          dropCard(queryClient, client, item.id);
          onAnswered?.();
        },
        onError: (failure) => {
          if (failure instanceof DaemonRequestError && failure.status === 409) {
            // Only a card that left the open list was answered elsewhere; any other 409 carries the
            // daemon's own reason, which the error line shows.
            void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
            void fetchRowOf(client, { state: InboxListState.Open }, item.id)
              .then((row) => {
                if (row !== null) return;
                if (onAnsweredElsewhere === undefined) setStale(true);
                else onAnsweredElsewhere();
                refreshCard(queryClient, client, item.id);
              })
              .catch(() => undefined);
          }
        },
      },
    );
  };

  return {
    respond,
    pending: answer.isPending,
    failure: stale
      ? 'This card was already answered.'
      : answer.isError
        ? answer.error.message
        : null,
  };
}
