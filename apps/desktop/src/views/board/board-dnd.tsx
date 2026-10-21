import type { TaskDto } from '@10db/contracts';
import {
  closestCorners,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ActionIcon, VisuallyHidden } from '@mantine/core';
import { IconGripVertical } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { columnKeyId, type LayoutColumn } from './board-layout';
import { dragRefusal, dropTarget, resolveDrop, type DropAction } from './drop-rules';

function Handle({
  task,
  refusal,
  sortable,
}: {
  readonly task: TaskDto;
  readonly refusal: string | null;
  readonly sortable: ReturnType<typeof useSortable>;
}) {
  // dnd-kit's sortable handle is a bag of refs and listeners the compiler cannot analyze.
  'use no memo';
  const reasonId = `drag-reason-${task.id}`;
  if (refusal)
    return (
      <>
        {/* aria-disabled, not disabled: a keyboard user can focus the handle and hear why it is locked. */}
        <ActionIcon
          variant="subtle"
          size="sm"
          aria-disabled="true"
          aria-describedby={reasonId}
          aria-label={`Can’t drag ${task.title}`}
          title={refusal}
          style={{ cursor: 'not-allowed', opacity: 0.5 }}
        >
          <IconGripVertical size={16} stroke={1.5} />
        </ActionIcon>
        <VisuallyHidden id={reasonId}>{refusal}</VisuallyHidden>
      </>
    );
  /* eslint-disable react-hooks/refs -- useSortable returns ref callbacks and listeners that the lint reads as render-time ref access. */
  return (
    <ActionIcon
      ref={sortable.setActivatorNodeRef}
      variant="subtle"
      size="sm"
      aria-label={`Drag ${task.title}`}
      style={{ cursor: 'grab' }}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <IconGripVertical size={16} stroke={1.5} />
    </ActionIcon>
  );
  /* eslint-enable react-hooks/refs */
}

function SortableCard({
  task,
  refusal,
  children,
}: {
  readonly task: TaskDto;
  readonly refusal: string | null;
  readonly children: (handle: ReactNode) => ReactNode;
}) {
  // dnd-kit's sortable handle is a bag of refs and listeners the compiler cannot analyze.
  'use no memo';
  const sortable = useSortable({ id: task.id, disabled: refusal !== null });
  /* eslint-disable react-hooks/refs -- useSortable returns ref callbacks and listeners that the lint reads as render-time ref access. */
  return (
    <li
      ref={sortable.setNodeRef}
      aria-label={task.title}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.6 : 1,
      }}
    >
      {children(<Handle task={task} refusal={refusal} sortable={sortable} />)}
    </li>
  );
  /* eslint-enable react-hooks/refs */
}

/** Makes the column's list a drop target, so an empty column or the space below its cards accepts a card. */
function DroppableColumn({
  column,
  children,
}: {
  readonly column: LayoutColumn;
  readonly children: (listRef: (element: HTMLElement | null) => void) => ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: `column:${columnKeyId(column.key)}` });
  return <>{children(setNodeRef)}</>;
}

export interface BoardDndProps {
  readonly layout: readonly LayoutColumn[];
  /** The cards to show per column (Done is cut to its limit). */
  readonly shown: (column: LayoutColumn) => readonly TaskDto[];
  readonly onDrop: (action: DropAction) => void;
  /** Renders a column; `listRef` goes on its `<ul>`, which becomes the column's drop target. */
  readonly renderColumn: (
    column: LayoutColumn,
    cards: ReactNode,
    listRef: (element: HTMLElement | null) => void,
  ) => ReactNode;
  readonly renderCard: (task: TaskDto, handle: ReactNode) => ReactNode;
}

/** One drag-and-drop context for the board; the drop rules decide what each drop does. */
export function BoardDnd({ layout, shown, onDrop, renderColumn, renderCard }: BoardDndProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const titles = new Map<string, string>(
    layout.flatMap((c) => c.tasks.map((t) => [t.id, t.title] as const)),
  );
  const title = (id: string | number) => titles.get(String(id)) ?? 'The card';
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${title(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${title(active.id)} is over ${String(over.id).startsWith('column:') ? 'an empty space' : title(over.id)}.`
        : `${title(active.id)} is over no column.`,
    onDragEnd: ({ active, over }) =>
      over ? `${title(active.id)} was dropped.` : `${title(active.id)} was put back.`,
    onDragCancel: ({ active }) => `Moving ${title(active.id)} was cancelled.`,
  };
  function handleDragEnd({ active, over }: DragEndEvent) {
    const target = dropTarget(layout, over === null ? null : String(over.id));
    if (target === null) return;
    const taskId = layout.flatMap((c) => c.tasks).find((t) => t.id === String(active.id))?.id;
    if (taskId === undefined) return;
    onDrop(resolveDrop(layout, taskId, target));
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragEnd={handleDragEnd}
      accessibility={{ announcements }}
    >
      {layout.map((column) => {
        const cards = shown(column);
        const refusal = dragRefusal(column.key);
        return (
          <DroppableColumn key={columnKeyId(column.key)} column={column}>
            {(listRef) =>
              renderColumn(
                column,
                <SortableContext
                  items={cards.map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {cards.map((task) => (
                    <SortableCard key={task.id} task={task} refusal={refusal}>
                      {(handle) => renderCard(task, handle)}
                    </SortableCard>
                  ))}
                </SortableContext>,
                listRef,
              )
            }
          </DroppableColumn>
        );
      })}
    </DndContext>
  );
}
