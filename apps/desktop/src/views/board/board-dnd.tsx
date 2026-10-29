import type { TaskDto, TaskId } from '@10db/contracts';
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Box, VisuallyHidden } from '@mantine/core';
import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { columnKeyId, type LayoutColumn } from './board-layout';
import { dragRefusal, dropTarget, type DropTarget } from './drop-rules';

function SortableCard({
  task,
  refusal,
  onOpen,
  menu,
  children,
}: {
  readonly task: TaskDto;
  readonly refusal: string | null;
  readonly onOpen: () => void;
  readonly menu: ReactNode;
  readonly children: ReactNode;
}) {
  // dnd-kit's sortable handle is a bag of refs and listeners the compiler cannot analyze.
  'use no memo';
  const sortable = useSortable({ id: task.id, disabled: refusal !== null });
  const reasonId = `drag-reason-${task.id}`;
  /* eslint-disable react-hooks/refs -- useSortable returns ref callbacks and listeners that the lint reads as render-time ref access. */
  return (
    // The list item is the sortable node; the card inside it is the one button that drags and opens. A
    // pointer drag starts only after 4px of movement, so a click still opens. A card that can't move
    // says why through its description, which a keyboard user hears on focus. The card's menu is a
    // sibling laid over its corner, not a child: a button can't hold another control, and the menu's
    // clicks and keys then never reach the card.
    <li
      ref={sortable.setNodeRef}
      aria-label={task.title}
      style={{
        position: 'relative',
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        // The card in flight is drawn by the overlay; its place in the list shows as a faint slot.
        opacity: sortable.isDragging ? 0.3 : 1,
      }}
    >
      <div
        ref={sortable.setActivatorNodeRef}
        {...(refusal ? {} : sortable.attributes)}
        {...(refusal ? {} : sortable.listeners)}
        role="button"
        tabIndex={0}
        aria-label={task.title}
        {...(refusal ? { 'aria-describedby': reasonId, title: refusal } : {})}
        onClick={onOpen}
        // Enter opens the details; Space, the sensor's start key, picks the card up. Only a key pressed
        // on the card itself counts: the menu's keys are stopped before they get here.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target === e.currentTarget) onOpen();
          else if (!refusal) sortable.listeners?.['onKeyDown']?.(e);
        }}
        style={{
          cursor: refusal ? 'pointer' : sortable.isDragging ? 'grabbing' : 'grab',
          borderRadius: 'var(--mantine-radius-md)',
        }}
      >
        {children}
      </div>
      <Box pos="absolute" top={8} right={8}>
        {menu}
      </Box>
      {refusal ? <VisuallyHidden id={reasonId}>{refusal}</VisuallyHidden> : null}
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
  /** A card was dropped on a target; the caller resolves it with the drop rules. */
  readonly onDrop: (taskId: TaskId, target: DropTarget) => void;
  /** Whether dropping the card on the target would do something, by the caller's drop rules. */
  readonly accepts: (taskId: TaskId, target: DropTarget) => boolean;
  /**
   * Renders a column; `listRef` goes on its `<ul>`, which becomes the column's drop target.
   * `targeted` is true while a dragged card is over the column and the column would take it.
   */
  readonly renderColumn: (
    column: LayoutColumn,
    cards: ReactNode,
    listRef: (element: HTMLElement | null) => void,
    targeted: boolean,
  ) => ReactNode;
  readonly renderCard: (task: TaskDto) => ReactNode;
  /** The card's actions menu, laid over its corner. */
  readonly renderMenu: (task: TaskDto) => ReactNode;
  /** A card was clicked, or Enter pressed on it: open its details. */
  readonly onOpen: (task: TaskDto) => void;
}

/** One drag-and-drop context for the board; it reports each drop and the caller's drop rules decide what it does. */
export function BoardDnd({
  layout,
  shown,
  onDrop,
  accepts,
  renderColumn,
  renderCard,
  renderMenu,
  onOpen,
}: BoardDndProps) {
  // A drop ends with a click on the card under the pointer; that click isn't an open. The flag clears
  // on the next macrotask, after the browser has dispatched that click.
  const justDropped = useRef(false);
  const open = (task: TaskDto) => {
    if (!justDropped.current) onOpen(task);
  };
  // The card being dragged, drawn in an overlay above every column so no column clips it.
  const [dragging, setDragging] = useState<TaskDto | null>(null);
  // The column under a dragged card, when it would take the card; null when nothing is dragged.
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const endDrag = () => {
    setDragging(null);
    setTargetKey(null);
    justDropped.current = true;
    setTimeout(() => {
      justDropped.current = false;
    }, 0);
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Enter is left to open the card's details, but it still ends a drag that is under way.
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
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
  const taskOf = (id: string | number) =>
    layout.flatMap((c) => c.tasks).find((t) => t.id === String(id));
  function handleDragStart({ active }: DragStartEvent) {
    setDragging(taskOf(active.id) ?? null);
  }
  function handleDragOver({ active, over }: DragOverEvent) {
    const target = dropTarget(layout, over === null ? null : String(over.id));
    const task = taskOf(active.id);
    setTargetKey(
      target !== null && task !== undefined && accepts(task.id, target)
        ? columnKeyId(target.key)
        : null,
    );
  }
  function handleDragEnd({ active, over }: DragEndEvent) {
    endDrag();
    const target = dropTarget(layout, over === null ? null : String(over.id));
    if (target === null) return;
    const taskId = layout.flatMap((c) => c.tasks).find((t) => t.id === String(active.id))?.id;
    if (taskId === undefined) return;
    onDrop(taskId, target);
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={endDrag}
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
                    <SortableCard
                      key={task.id}
                      task={task}
                      refusal={refusal}
                      menu={renderMenu(task)}
                      onOpen={() => {
                        open(task);
                      }}
                    >
                      {renderCard(task)}
                    </SortableCard>
                  ))}
                </SortableContext>,
                listRef,
                targetKey === columnKeyId(column.key),
              )
            }
          </DroppableColumn>
        );
      })}
      {/* Portaled to the body, so neither a column nor its scroll area clips the card in flight. */}
      {createPortal(
        <DragOverlay>{dragging ? renderCard(dragging) : null}</DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
