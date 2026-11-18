import { InboxListState, PlanChoice, type InboxItemDto } from '@10db/contracts';
import { Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DaemonRequestError } from '../../daemon/client';
import { dropCard, refreshCard } from '../../daemon/inbox-live';
import { fetchRowOf } from '../../daemon/inbox-queries';
import { useDaemon } from '../../daemon/provider';
import { queryKeys, useAnswerInbox } from '../../daemon/queries';
import { CardSurface } from './card-surface';

const NOTE_MAX_LENGTH = 4000;

export interface PlanCardProps {
  readonly item: InboxItemDto;
  /** The kind badge and title, laid out as on every other expanded card. */
  readonly header: ReactNode;
  /** The Send Back note, kept by the Inbox so deselecting the card does not lose it. */
  readonly note: string;
  readonly onNote: (note: string) => void;
  /**
   * Called when the card turned out to be answered elsewhere. The Inbox shows the notice itself, since the
   * card goes with its row; without it the card says so on its own.
   */
  readonly onAnsweredElsewhere?: () => void;
  /** Whether the card draws its own border; false where the Inbox's content area already frames it. */
  readonly framed?: boolean;
}

/**
 * A plan waiting for the builder before the build starts: they read it and either approve it or send
 * it back with a note saying what to change. Answered by its buttons, never by an Inbox key.
 */
export function PlanCard({
  item,
  header,
  note,
  onNote,
  onAnsweredElsewhere,
  framed = true,
}: PlanCardProps) {
  const answer = useAnswerInbox();
  const queryClient = useQueryClient();
  const { client } = useDaemon();
  const [sendingBack, setSendingBack] = useState(note !== '');
  const [stale, setStale] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const sendBackRef = useRef<HTMLButtonElement>(null);
  const wasSendingBack = useRef(false);
  // Set by the Send Back button so only a user opening the panel moves focus, not a remount.
  const openedByUser = useRef(false);
  const trimmed = note.trim();

  useEffect(() => {
    if (sendingBack) {
      if (openedByUser.current) noteRef.current?.focus();
    } else if (wasSendingBack.current) sendBackRef.current?.focus();
    openedByUser.current = false;
    wasSendingBack.current = sendingBack;
  }, [sendingBack]);

  const respond = (given: { choice: string; note?: string }): void => {
    setStale(false);
    answer.mutate(
      { id: item.id, answer: given },
      {
        onSuccess: () => {
          dropCard(queryClient, item.id);
          onNote('');
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
  const failure = stale
    ? 'This card was already answered.'
    : answer.isError
      ? answer.error.message
      : null;

  return (
    <CardSurface framed={framed}>
      <Stack gap="sm">
        {header}
        {item.body === '' ? null : (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {item.body}
          </Text>
        )}
        {sendingBack ? (
          <Textarea
            ref={noteRef}
            label="What needs to change in the plan"
            description="The planner gets this note and plans again."
            autosize
            minRows={2}
            maxLength={NOTE_MAX_LENGTH}
            value={note}
            onChange={(e) => {
              onNote(e.currentTarget.value);
            }}
          />
        ) : null}
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          {failure === null ? (
            <span />
          ) : (
            <Text size="sm" c="red" role="alert">
              {failure}
            </Text>
          )}
          <Group justify="flex-end">
            {sendingBack ? (
              <>
                <Button
                  variant="default"
                  onClick={() => {
                    // A kept note would reopen the panel when the card is selected again.
                    onNote('');
                    setSendingBack(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  color="red"
                  loading={answer.isPending}
                  disabled={trimmed === ''}
                  onClick={() => {
                    respond({ choice: PlanChoice.SendBack, note: trimmed });
                  }}
                >
                  Send It Back
                </Button>
              </>
            ) : (
              <>
                <Button
                  ref={sendBackRef}
                  variant="default"
                  disabled={answer.isPending}
                  onClick={() => {
                    openedByUser.current = true;
                    setSendingBack(true);
                  }}
                >
                  Send Back
                </Button>
                <Button
                  loading={answer.isPending}
                  onClick={() => {
                    respond({ choice: PlanChoice.Approve });
                  }}
                >
                  Approve
                </Button>
              </>
            )}
          </Group>
        </Group>
      </Stack>
    </CardSurface>
  );
}
