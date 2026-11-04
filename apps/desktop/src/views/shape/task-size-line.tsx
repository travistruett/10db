import type { ShapeTaskSizeDto, TaskId } from '@10db/contracts';
import { Text } from '@mantine/core';
import { IconClockExclamation } from '@tabler/icons-react';
import { useShapeOf, useShapeView } from '../../daemon/shape-queries';
import { sizeLine } from './size-line';

// Shape spec §8 Calibration, shown: "Sized M (~2 h) · took 5 h of lane time", with a
// clock-exclamation icon when the actual is more than one bucket from the size.

/** One task's size line, as the Proposed list and a task's drawer both write it. */
export function SizeLineText({ size }: { readonly size: ShapeTaskSizeDto }) {
  const line = sizeLine(size);
  return (
    <Text size="xs" c="dimmed">
      {line.text}
      {line.flagged ? (
        <>
          {' '}
          <IconClockExclamation
            size={14}
            stroke={1.5}
            role="img"
            aria-label="Outside its size by more than one bucket"
            style={{ verticalAlign: '-2px' }}
          />
        </>
      ) : null}
    </Text>
  );
}

/**
 * The size line of a task a conversation converted, in its drawer: the size and hours Shape derived
 * and, once the task has finished, the lane time it took. Shown nothing for a task filed by hand or
 * one the conversation did not size.
 */
export function TaskSizeLine({ taskId }: { readonly taskId: TaskId }) {
  const of = useShapeOf({ taskId });
  const view = useShapeView(of.data?.shapeId ?? null);
  const size = view.data?.sizes.find((s) => s.taskId === taskId);
  return size === undefined ? null : <SizeLineText size={size} />;
}
