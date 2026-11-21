import type { ShapeProposalDto, ShapeTaskSizeDto } from '@10db/contracts';
import { Box, Stack } from '@mantine/core';
import { use, useState, type KeyboardEvent } from 'react';
import {
  attachmentsOf,
  AttachmentsContext,
  mockupState,
  RowAttachments,
} from './attachments/row-attachments';
import { RowChips } from './row-chips';
import { RowLine, moveRowFocus } from './row-line';
import type { TaskReview } from './review-lines';
import { Items, Labelled, SizeFacts } from './row-details';
import { ReviewNotes } from './review-notes';
import type { RowHandlers } from './proposal-row';

type GoalTask = Extract<ShapeProposalDto, { kind: 'goal' }>['body']['tasks'][number];

export interface GoalTaskRowProps {
  readonly goal: Extract<ShapeProposalDto, { kind: 'goal' }>;
  readonly task: GoalTask;
  readonly index: number;
  readonly size: ShapeTaskSizeDto | undefined;
  /** The rehearsal's open questions about this task; absent once the goal is accepted. */
  readonly review: TaskReview | undefined;
  readonly handlers: RowHandlers;
}

/**
 * One of a goal's tasks inside its card: the title and chips on a line, and opened its description,
 * criteria, area and estimate, the rehearsal's questions and its mock-ups. A goal's tasks are edited
 * through the goal, so the line has no actions.
 */
export function GoalTaskRow({ goal, task, index, size, review, handlers }: GoalTaskRowProps) {
  const [opened, setOpened] = useState(false);
  const { attachments } = use(AttachmentsContext);
  const ref = { key: task.key, index };
  const mockup = mockupState(attachmentsOf(goal, attachments, ref));
  const questions = review?.questions ?? [];
  const regionId = `shape-row-${goal.id}-${task.key}`;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : null;
    if (delta !== null && moveRowFocus(event.currentTarget, delta)) event.preventDefault();
  };
  return (
    <li style={{ listStyle: 'none' }}>
      <RowLine
        title={task.title}
        chips={
          <RowChips
            facts={{
              meta: size?.size ?? task.size,
              questions: questions.length,
              mockup,
            }}
          />
        }
        opened={opened}
        regionId={regionId}
        tabbable={false}
        onToggle={() => {
          setOpened((o) => !o);
        }}
        onKeyDown={onKeyDown}
      />
      {opened ? (
        <Box id={regionId} role="region" aria-label={`${task.title} details`} px={8} pb={6} pl={24}>
          <Stack gap="xs">
            <ReviewNotes findings={[]} questions={questions} onDismiss={handlers.onDismiss} />
            {task.description === '' ? null : (
              <Labelled label="Description">{task.description}</Labelled>
            )}
            <Items label="Criteria" items={task.criteria} />
            {task.depends_on.length === 0 ? null : (
              <Labelled label="Depends on">{task.depends_on.join(', ')}</Labelled>
            )}
            <SizeFacts areas={task.areas} size={size} />
            <RowAttachments row={goal} title={task.title} task={ref} />
          </Stack>
        </Box>
      ) : null}
    </li>
  );
}
