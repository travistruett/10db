import {
  AcceptanceChoice,
  AcceptanceDetail,
  AcceptanceVerdict,
  type InboxItemDto,
} from '@10db/contracts';
import { List, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { CardActions } from './card-actions';
import { CardSurface } from './card-surface';
import classes from './inbox-card.module.css';
import { useCardAnswer } from './use-card-answer';
import { useViewTaskButton } from './view-task';

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
  const answer = useCardAnswer(item, {
    onAnswered: () => {
      onNote('');
    },
    onAnsweredElsewhere,
  });
  const viewTask = useViewTaskButton(item, !framed);
  const detail = AcceptanceDetail.safeParse(item.detail);
  const open = detail.success
    ? detail.data.criteria.filter((c) => c.verdict !== AcceptanceVerdict.Met)
    : [];

  return (
    <CardSurface framed={framed}>
      <Stack gap={framed ? 'sm' : 'md'} className={framed ? undefined : classes['content']}>
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
      </Stack>
      <CardActions
        framed={framed}
        start={[viewTask]}
        error={answer.failure}
        sendBack={{
          label: 'What Needs to Change',
          description: 'The follow-up task gets this note.',
          note,
          onNote,
          onSend: (trimmed) => {
            answer.respond({ choice: AcceptanceChoice.SendBack, note: trimmed });
          },
          pending: answer.pending,
        }}
        primary={{
          label: 'Accept',
          loading: answer.pending,
          onClick: () => {
            answer.respond({ choice: AcceptanceChoice.Accept });
          },
        }}
      />
    </CardSurface>
  );
}
