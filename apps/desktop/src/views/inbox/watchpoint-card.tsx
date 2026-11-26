import { InboxListState, WatchpointChoice, type InboxItemDto } from '@10db/contracts';
import { Anchor, Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { DaemonRequestError } from '../../daemon/client';
import { dropCard, refreshCard } from '../../daemon/inbox-live';
import { fetchRowOf } from '../../daemon/inbox-queries';
import { useDaemon } from '../../daemon/provider';
import { queryKeys, useAnswerInbox, useWorkstreams } from '../../daemon/queries';
import { useWatchpointHits } from '../../daemon/watchpoint-queries';
import { WatchpointFolds, WholeDiff } from '../board/watchpoint-folds';
import { useOpenTask } from '../sessions/open-session';
import { CardSurface } from './card-surface';

const NOTE_MAX_LENGTH = 4000;

export interface WatchpointCardProps {
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
 * A change that hit a watchpoint set to ask: the folds of the run's reading (read live, so the reviewer's check
 * shows once it ends), then Looks right or a send back with a note, which files a follow-up task. The run never
 * waits on this card.
 */
export function WatchpointCard({
  item,
  header,
  note,
  onNote,
  onAnsweredElsewhere,
  framed = true,
}: WatchpointCardProps) {
  const answer = useAnswerInbox();
  const queryClient = useQueryClient();
  const { client } = useDaemon();
  const [sendingBack, setSendingBack] = useState(note !== '');
  const [stale, setStale] = useState(false);
  const workstreamId = item.targets[0]?.workstreamId;
  const reading = useWatchpointHits(workstreamId).data;
  const workstreams = useWorkstreams({ active: false });
  const taskId = workstreams.data?.find((w) => w.id === workstreamId)?.taskId;
  const openTask = useOpenTask();
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
          The change touched what you asked to look at yourself. Looks right closes this card, or
          send it back and 10db files a task with your note.
        </Text>
        {taskId === undefined ? null : (
          <Anchor
            component="button"
            type="button"
            size="sm"
            onClick={() => {
              void openTask({ taskId, projectId: item.projectId });
            }}
          >
            Open the task
          </Anchor>
        )}
        {reading === undefined || reading.hits.length === 0 ? null : (
          <Stack gap="xs" data-testid="look-folds">
            {reading.canOpenDiff && workstreamId !== undefined ? (
              <Group justify="flex-end">
                <WholeDiff workstreamId={workstreamId} />
              </Group>
            ) : null}
            <WatchpointFolds hits={reading.hits} open="all" />
          </Stack>
        )}
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
                      respond({ choice: WatchpointChoice.SendBack, note: trimmed });
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
                  Send back with a note
                </Button>
                <Button
                  loading={answer.isPending}
                  onClick={() => {
                    respond({ choice: WatchpointChoice.LooksRight });
                  }}
                >
                  Looks right
                </Button>
              </>
            )}
          </Group>
        </Group>
      </Stack>
    </CardSurface>
  );
}
