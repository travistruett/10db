import { PlanChoice, type InboxItemDto } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { CardActions } from './card-actions';
import { CardSurface } from './card-surface';
import { decisionLine } from './decision-line';
import classes from './inbox-card.module.css';
import { useCardAnswer } from './use-card-answer';
import { useViewTaskButton } from './view-task';

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
  const answer = useCardAnswer(item, {
    onAnswered: () => {
      onNote('');
    },
    onAnsweredElsewhere,
  });
  const viewTask = useViewTaskButton(item, !framed);

  return (
    <CardSurface framed={framed}>
      <Stack gap={framed ? 'sm' : 'md'} className={framed ? undefined : classes['content']}>
        {header}
        {item.body === '' ? null : (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {item.body}
          </Text>
        )}
      </Stack>
      <CardActions
        framed={framed}
        start={[viewTask]}
        error={answer.failure}
        decision={decisionLine(item)}
        sendBack={{
          label: 'What Needs to Change in the Plan',
          buttonLabel: 'Re-plan',
          description: 'The planner gets this note and plans again.',
          note,
          onNote,
          onSend: (trimmed) => {
            answer.respond({ choice: PlanChoice.SendBack, note: trimmed });
          },
          pending: answer.pending,
        }}
        primary={{
          label: 'Approve',
          loading: answer.pending,
          onClick: () => {
            answer.respond({ choice: PlanChoice.Approve });
          },
        }}
      />
    </CardSurface>
  );
}
