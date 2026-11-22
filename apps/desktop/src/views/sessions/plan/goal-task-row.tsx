import type { ShapeProposalDto, ShapeTaskSizeDto } from '@10db/contracts';
import type { KeyboardEvent } from 'react';
import { RowAttachments } from './attachments/row-attachments';
import type { RowHandlers } from './proposal-row';
import type { TaskReview } from './review-lines';
import { ReviewNotes } from './review-notes';
import { RowChips } from './row-chips';
import { DetailBlock, taskFacts } from './row-details';
import classes from './plan-rows.module.css';
import { RowLine, moveRowFocus, type OpenRow } from './row-line';
import { Box, Collapse } from '@mantine/core';

type GoalProposal = Extract<ShapeProposalDto, { kind: 'goal' }>;

export interface GoalTaskRowProps {
  readonly goal: GoalProposal;
  readonly task: GoalProposal['body']['tasks'][number];
  readonly size: ShapeTaskSizeDto | undefined;
  /** The rehearsal's open questions about this task; absent once the goal is accepted. */
  readonly review: TaskReview | undefined;
  readonly handlers: RowHandlers;
  readonly open: OpenRow | null;
  readonly onOpenChange: (next: OpenRow | null) => void;
}

/**
 * One of a goal's tasks inside its card: the title, its notes and its size on a line, and opened its
 * description, notes, criteria, area and estimate and its mock-ups. A goal's tasks are edited through
 * the goal, so the line has no actions.
 */
export function GoalTaskRow({
  goal,
  task,
  size,
  review,
  handlers,
  open,
  onOpenChange,
}: GoalTaskRowProps) {
  const id = `${goal.id}:${task.key}`;
  const opened = open?.id === id;
  const questions = review?.questions ?? [];
  const regionId = `shape-row-${goal.id}-${task.key}`;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : null;
    if (delta !== null && moveRowFocus(event.currentTarget, delta)) event.preventDefault();
  };
  return (
    <li
      className={classes['item']}
      {...(opened ? { 'data-open': '' } : {})}
      style={{ listStyle: 'none' }}
    >
      <RowLine
        title={task.title}
        chips={<RowChips facts={{ notes: questions.length }} />}
        trailing={size?.size ?? task.size}
        opened={opened}
        regionId={regionId}
        tabbable={false}
        onToggle={() => {
          onOpenChange(opened ? null : { id, editing: false });
        }}
        onKeyDown={onKeyDown}
      />
      <Collapse expanded={opened} keepMounted={false} transitionDuration={150}>
        <Box
          id={regionId}
          role="region"
          aria-label={`${task.title} details`}
          px={12}
          pt={4}
          pb={16}
        >
          <DetailBlock
            description={task.description}
            notes={
              questions.length === 0 ? undefined : (
                <ReviewNotes findings={[]} questions={questions} onDismiss={handlers.onDismiss} />
              )
            }
            criteria={task.criteria}
            facts={taskFacts(task.areas, size, task.depends_on)}
            flagged={size?.missized === true}
            attachments={<RowAttachments row={goal} title={task.title} task={{ key: task.key }} />}
          />
        </Box>
      </Collapse>
    </li>
  );
}
