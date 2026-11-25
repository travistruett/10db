import {
  AcceptanceChoice,
  AcceptanceDetail,
  AcceptanceVerdict,
  InboxListState,
  type InboxItemDto,
} from '@10db/contracts';
import { Button, Group, List, Stack, Text, Textarea } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { DaemonRequestError } from '../../daemon/client';
import { dropCard, refreshCard } from '../../daemon/inbox-live';
import { fetchRowOf } from '../../daemon/inbox-queries';
import { useDaemon } from '../../daemon/provider';
import { queryKeys, useAnswerInbox } from '../../daemon/queries';
import { CardSurface } from './card-surface';

const NOTE_MAX_LENGTH = 4000;

export interface AcceptanceCardProps {
  readonly item: InboxItemDto;
  /** The kind badge and title, laid out as on every other expanded card. */
  readonly header: ReactNode;
  /** The Send back note, kept by the Inbox so deselecting the card does not lose it. */
  readonly note: string;
  readonly onNote: (note: string) => void;
  /** Called when the card turned out to be answered elsewhere; without it the card says so itself. */
  readonly onAnsweredElsewhere?: () => void;
  readonly framed?: boolean;
}

/**
 * Criteria the acceptance check could not confirm on work that shipped: the builder accepts them as they are or
 * sends them back with a note, which files a follow-up task. The run never waits on this card.
 */
export function AcceptanceCard({
  item,
  header,
  note,
  onNote,
  onAnsweredElsewhere,
  framed = true,
}: AcceptanceCardProps) {
  const answer = useAnswerInbox();
  const queryClient = useQueryClient();
  const { client } = useDaemon();
  const [sendingBack, setSendingBack] = useState(note !== '');
  const [stale, setStale] = useState(false);
  const detail = AcceptanceDetail.safeParse(item.detail);
  const open = detail.success
    ? detail.data.criteria.filter((c) => c.verdict !== AcceptanceVerdict.Met)
    : [];
  const trimmed = note.trim();

  const respond = (given: { choice: string; note?: string }): void => {
    setStale(false);
    answer.mutate(
      { id: item.id, answer: given },
      {
        onSuccess: () => {
          dropCard(queryClient, client, item.id);
          onNote('');
        },
        onError: (failure) => {
          if (failure instanceof DaemonRequestError && failure.status === 409) {
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
        <Text size="sm">
          {item.detail?.['reviewFollows'] === true
            ? 'The work went on to review'
            : 'The work shipped'}
          . 10db could not confirm these acceptance criteria. Accept the work as it is, or send it
          back and 10db files a task to meet them.
        </Text>
        {open.length === 0 ? null : (
          <List size="sm" spacing={4}>
            {open.map((c) => (
              <List.Item key={c.criterion}>
                {c.criterion}
                <Text size="xs" c="dimmed">
                  {c.note}
                </Text>
              </List.Item>
            ))}
          </List>
        )}
        {detail.success && detail.data.unasked !== null ? (
          <Text size="sm">
            It may also do something the task didn't ask for: {detail.data.unasked}
          </Text>
        ) : null}
        {sendingBack ? (
          <Textarea
            label="What Needs to Change"
            description="The follow-up task gets this note."
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
                    if (trimmed !== '')
                      respond({ choice: AcceptanceChoice.SendBack, note: trimmed });
                  }}
                >
                  Send It Back
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="default"
                  disabled={answer.isPending}
                  onClick={() => {
                    setSendingBack(true);
                  }}
                >
                  Send Back
                </Button>
                <Button
                  loading={answer.isPending}
                  onClick={() => {
                    respond({ choice: AcceptanceChoice.Accept });
                  }}
                >
                  Accept
                </Button>
              </>
            )}
          </Group>
        </Group>
      </Stack>
    </CardSurface>
  );
}
