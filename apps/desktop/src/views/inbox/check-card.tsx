import {
  CheckChoice,
  type InboxItemDto,
  type WorkstreamChangesDto,
  type WorkstreamId,
} from '@10db/contracts';
import { Alert, Box, Code, Group, List, Stack, Text } from '@mantine/core';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { useTasks, useWorkstreamChanges, useWorkstreams } from '../../daemon/queries';
import { CardActions } from './card-actions';
import { CardSurface } from './card-surface';
import { decisionLine } from './decision-line';
import classes from './inbox-card.module.css';
import { useCardAnswer } from './use-card-answer';
import { KEYS_IGNORE_ATTRIBUTE } from './use-inbox-keys';
import { useViewTaskButton } from './view-task';

const SHORT_SHA = 7;
/** Light-scheme Code takes the card's own color, so it needs a surface and an edge of its own. */
const CODE_SURFACE = {
  background: 'var(--mantine-color-default-hover)',
  border: '1px solid var(--mantine-color-default-border)',
} as const;

/** The part of a check card's detail the card reads: the head the work reached. */
export const CheckDetail = z.object({ head: z.string() });

export interface CheckCardProps {
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
        Acceptance Criteria
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
            <Code key={sha} style={CODE_SURFACE}>
              {sha.slice(0, SHORT_SHA)}
            </Code>
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
        <Code block style={{ ...CODE_SURFACE, whiteSpace: 'pre' }}>
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
export function CheckCard({
  item,
  header,
  note,
  onNote,
  onAnsweredElsewhere,
  framed = true,
}: CheckCardProps) {
  const answer = useCardAnswer(item, {
    onAnswered: () => {
      onNote('');
    },
    onAnsweredElsewhere,
  });
  const viewTask = useViewTaskButton(item, !framed);
  const workstreamId = item.targets[0]?.workstreamId;
  const detail = CheckDetail.safeParse(item.detail);
  const changes = useWorkstreamChanges(workstreamId, detail.success ? detail.data.head : null);
  const failure =
    answer.failure ??
    (changes.isError ? 'The changes did not load. You can still approve without them.' : null);
  // The diff on screen is the one for this card's head, so Approve waits until it has loaded.
  const loadingChanges = workstreamId !== undefined && changes.isPending;

  return (
    // Not the Inbox's selected-card scope: a check card is answered by its buttons, not by the Inbox keys.
    <CardSurface framed={framed}>
      <Stack gap={framed ? 'sm' : 'md'} className={framed ? undefined : classes['content']}>
        {header}
        {item.body === '' ? null : <Text size="sm">{item.body}</Text>}
        {workstreamId === undefined ? null : (
          <>
            <Criteria item={item} workstreamId={workstreamId} />
            <Changes changes={changes} />
          </>
        )}
      </Stack>
      <CardActions
        framed={framed}
        start={[viewTask]}
        error={failure}
        decision={decisionLine(item)}
        sendBack={{
          label: 'What Needs to Change',
          description: 'The agent gets this note with the work.',
          note,
          onNote,
          onSend: (trimmed) => {
            answer.respond({ choice: CheckChoice.SendBack, note: trimmed });
          },
          pending: answer.pending,
        }}
        primary={{
          label: 'Approve and Finish',
          loading: answer.pending,
          disabled: loadingChanges,
          onClick: () => {
            answer.respond({ choice: CheckChoice.Approve });
          },
        }}
      />
    </CardSurface>
  );
}
