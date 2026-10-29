import {
  CheckChoice,
  type InboxItemDto,
  type WorkstreamChangesDto,
  type WorkstreamId,
} from '@10db/contracts';
import { Alert, Box, Button, Code, Group, List, Paper, Stack, Text, Textarea } from '@mantine/core';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { DaemonRequestError } from '../../daemon/client';
import {
  queryKeys,
  useAnswerInbox,
  useTasks,
  useWorkstreamChanges,
  useWorkstreams,
} from '../../daemon/queries';
import { KEYS_IGNORE_ATTRIBUTE } from './use-inbox-keys';

const SHORT_SHA = 7;
const NOTE_MAX_LENGTH = 4000;

/** The part of a check card's detail the card reads: the head the work reached. */
const CheckDetail = z.object({ head: z.string() });

export interface CheckCardProps {
  readonly item: InboxItemDto;
  /** The kind badge and title, laid out as on every other expanded card. */
  readonly header: ReactNode;
  /** The Send Back note, kept by the Inbox so deselecting the card does not lose it. */
  readonly note: string;
  readonly onNote: (note: string) => void;
}

/** The criteria the task set, so the builder checks the work against them. */
function Criteria({
  item,
  workstreamId,
}: {
  readonly item: InboxItemDto;
  readonly workstreamId: WorkstreamId;
}) {
  const workstreams = useWorkstreams({ active: true });
  const tasks = useTasks(item.projectId);
  const taskId = workstreams.data?.find((w) => w.id === workstreamId)?.taskId;
  const criteria = tasks.data?.find((t) => t.id === taskId)?.acceptanceCriteria ?? [];
  if (criteria.length === 0) return null;
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        Acceptance criteria
      </Text>
      <List size="sm" spacing={2}>
        {criteria.map((criterion, index) => (
          <List.Item key={`${String(index)}:${criterion}`}>{criterion}</List.Item>
        ))}
      </List>
    </Stack>
  );
}

/** Commits, changed files with their counts and the diff; all of it is repository text, shown only as text. */
function Changes({ changes }: { readonly changes: UseQueryResult<WorkstreamChangesDto> }) {
  if (changes.isError)
    return (
      <Alert color="red" variant="light" title="Couldn't load the changes">
        {changes.error.message}
      </Alert>
    );
  if (!changes.isSuccess)
    return (
      <Text size="sm" c="dimmed">
        Loading the changes…
      </Text>
    );
  const { commits, files, diff, truncated } = changes.data;
  return (
    <>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Commits
        </Text>
        <Group gap="xs">
          {commits.map((sha) => (
            <Code key={sha}>{sha.slice(0, SHORT_SHA)}</Code>
          ))}
        </Group>
      </Stack>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Files
        </Text>
        <List size="sm" spacing={2} listStyleType="none">
          {files.map((file) => (
            <List.Item key={file.path}>
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" ff="monospace">
                  {file.path}
                </Text>
                {file.added === null || file.removed === null ? null : (
                  <>
                    <Text size="sm" c="green" ff="monospace">{`+${String(file.added)}`}</Text>
                    <Text size="sm" c="red" ff="monospace">{`-${String(file.removed)}`}</Text>
                  </>
                )}
              </Group>
            </List.Item>
          ))}
        </List>
      </Stack>
      {/* Focusable so the keyboard can scroll it; the Inbox keys leave its arrows alone. */}
      <Box
        role="region"
        aria-label="Diff"
        tabIndex={0}
        {...{ [KEYS_IGNORE_ATTRIBUTE]: true }}
        style={{ maxHeight: 360, overflow: 'auto' }}
      >
        <Code block style={{ whiteSpace: 'pre' }}>
          {diff}
        </Code>
      </Box>
      {truncated ? (
        <Text size="sm" c="dimmed">
          The diff is longer than we show. The file list above is complete.
        </Text>
      ) : null}
    </>
  );
}

/**
 * Finished work the project has no gate for: the builder checks the changes and either approves
 * them or sends them back with a note saying what to fix.
 */
export function CheckCard({ item, header, note, onNote }: CheckCardProps) {
  const answer = useAnswerInbox();
  const queryClient = useQueryClient();
  const [sendingBack, setSendingBack] = useState(note !== '');
  const [stale, setStale] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const sendBackRef = useRef<HTMLButtonElement>(null);
  const wasSendingBack = useRef(false);
  // Set by the Send Back button so only a user opening the panel moves focus, not a remount.
  const openedByUser = useRef(false);
  const workstreamId = item.targets[0]?.workstreamId;
  const detail = CheckDetail.safeParse(item.detail);
  const changes = useWorkstreamChanges(workstreamId, detail.success ? detail.data.head : null);
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
          onNote('');
        },
        onError: (failure) => {
          if (failure instanceof DaemonRequestError && failure.status === 409) {
            // Only a card that left the refetched inbox was answered elsewhere; any other 409
            // carries the daemon's own reason, which the error line shows.
            void queryClient.invalidateQueries({ queryKey: queryKeys.inbox }).then(() => {
              const open = queryClient.getQueryData<InboxItemDto[]>(queryKeys.inbox);
              if (open !== undefined && !open.some((candidate) => candidate.id === item.id))
                setStale(true);
            });
          }
        },
      },
    );
  };
  const approve = (): void => {
    respond({ choice: CheckChoice.Approve });
  };
  const sendBack = (): void => {
    if (trimmed === '') return;
    respond({ choice: CheckChoice.SendBack, note: trimmed });
  };
  const failure = stale
    ? 'This card was already answered.'
    : answer.isError
      ? answer.error.message
      : changes.isError
        ? 'The changes did not load. You can still approve without them.'
        : null;
  // The diff on screen is the one for this card's head, so Approve waits until it has loaded.
  const loadingChanges = workstreamId !== undefined && changes.isPending;

  return (
    // Not the Inbox's selected-card scope: a check card is answered by its buttons, not by the Inbox keys.
    <Paper withBorder p="md" shadow="xs">
      <Stack gap="sm">
        {header}
        {item.body === '' ? null : <Text size="sm">{item.body}</Text>}
        {workstreamId === undefined ? null : (
          <>
            <Criteria item={item} workstreamId={workstreamId} />
            <Changes changes={changes} />
          </>
        )}
        {sendingBack ? (
          <Textarea
            ref={noteRef}
            label="What needs to change"
            description="The agent gets this note with the work."
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
                  onClick={sendBack}
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
                <Button loading={answer.isPending} disabled={loadingChanges} onClick={approve}>
                  Approve
                </Button>
              </>
            )}
          </Group>
        </Group>
      </Stack>
    </Paper>
  );
}
