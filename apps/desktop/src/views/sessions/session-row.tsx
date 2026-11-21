import { Loader, Text, Tooltip } from '@mantine/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconGitPullRequest,
  IconPlayerPause,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { CREATE_SLOT_CLASS } from '../../shell/create-button';
import { RowMark, type RowState } from './row-state';
import classes from './session-row.module.css';

/** The mark at a row's right: a spinner (a still dot under reduced motion) or a glyph, each its own shape. */
function MarkIcon({ mark }: { readonly mark: RowMark }): ReactNode {
  switch (mark) {
    case RowMark.Working:
      return (
        <>
          <Loader size={12} className={classes['spin']} aria-hidden="true" />
          <span className={classes['dot']} aria-hidden="true" />
        </>
      );
    case RowMark.NeedsYou:
      return <IconAlertCircle size={14} stroke={1.5} color="var(--mantine-color-yellow-filled)" />;
    case RowMark.Error:
      return <IconAlertTriangle size={14} stroke={1.5} color="var(--mantine-color-red-filled)" />;
    case RowMark.Paused:
      return <IconPlayerPause size={14} stroke={1.5} color="var(--mantine-color-orange-filled)" />;
    case RowMark.PullRequest:
      return <IconGitPullRequest size={14} stroke={1.5} color="var(--mantine-color-dimmed)" />;
    case RowMark.Merged:
      return <IconCheck size={14} stroke={1.5} color="var(--mantine-color-green-filled)" />;
  }
}

export interface SessionRowProps {
  /** The row's key: what the panel and the keys agree on. */
  readonly rowKey: string;
  readonly title: string;
  /** A fresh row: dim and italic, until its first message makes it a session. */
  readonly fresh?: boolean;
  /** Absent for a fresh row, which has no state. */
  readonly state?: RowState;
  /** The accessible name: title, project and what the state says. */
  readonly name: string;
  /** The tooltip's second line: the project and the agent. */
  readonly detail: string;
  readonly selected: boolean;
  /** The one row of the list the Tab key reaches; the arrow keys move between the rows from there. */
  readonly tabbable: boolean;
  /** Whether a drag can move this row. */
  readonly draggable: boolean;
  readonly onSelect: () => void;
  readonly onClose: () => void;
  readonly onRename: () => void;
  readonly onContextMenu: (event: MouseEvent) => void;
}

/**
 * One 32 px row of the panel: its title and one state mark (where the session works is its title row's line). Hovered, × takes the mark's
 * place. A ring stays around a row that needs the builder; no state is told by colour alone.
 */
export function SessionRow({
  rowKey,
  title,
  fresh = false,
  state,
  name,
  detail,
  selected,
  tabbable,
  draggable,
  onSelect,
  onClose,
  onRename,
  onContextMenu,
}: SessionRowProps) {
  // dnd-kit's sortable handle is a bag of refs and listeners the compiler cannot analyze.
  'use no memo';
  const sortable = useSortable({ id: rowKey, disabled: !draggable });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      onSelect();
    } else if (event.key === 'Delete') {
      event.preventDefault();
      onClose();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const rows = [
        ...(event.currentTarget.closest('[role="listbox"]')?.querySelectorAll('[role="option"]') ??
          []),
      ];
      const at = rows.indexOf(event.currentTarget);
      const target =
        event.key === 'Home'
          ? rows[0]
          : event.key === 'End'
            ? rows.at(-1)
            : rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
      if (target instanceof HTMLElement) {
        event.preventDefault();
        target.focus();
      }
    }
  };
  const ring =
    state?.mark === RowMark.NeedsYou ? 'needs_you' : state?.mark === RowMark.Error ? 'error' : null;
  return (
    <Tooltip
      openDelay={500}
      withinPortal
      multiline
      disabled={sortable.isDragging}
      position="right"
      label={
        <>
          <Text size="xs" fw={600}>
            {title}
          </Text>
          <Text size="xs">{detail}</Text>
        </>
      }
    >
      <div
        ref={(node) => {
          sortable.setNodeRef(node);
        }}
        role="option"
        aria-label={name}
        aria-selected={selected}
        tabIndex={tabbable ? 0 : -1}
        className={`${classes['row'] ?? ''} ${classes['nested'] ?? ''}${fresh ? ` ${CREATE_SLOT_CLASS}` : ''}`}
        data-session-row={rowKey}
        data-selected={selected ? '' : undefined}
        data-ring={ring ?? undefined}
        data-state={state?.mark ?? 'idle'}
        data-place={state?.icon}
        aria-describedby={sortable.attributes['aria-describedby']}
        {...sortable.listeners}
        onClick={onSelect}
        onDoubleClick={fresh ? undefined : onRename}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        style={{
          transform: CSS.Transform.toString(
            sortable.transform === null ? null : { ...sortable.transform, x: 0 },
          ),
          transition: sortable.transition,
          opacity: sortable.isDragging ? 0.6 : 1,
        }}
      >
        {/* Where a session works is its title row's line; a fresh tab is a button for a new one, so it has a +. */}
        {fresh ? (
          <span className={classes['icon']} aria-hidden="true">
            <IconPlus size={14} stroke={1.5} />
          </span>
        ) : null}
        <span
          className={classes['title']}
          data-fresh={fresh ? '' : undefined}
          style={{
            fontWeight: selected || state?.bold === true ? 600 : 400,
            ...(state?.dim === true ? { color: 'var(--mantine-color-dimmed)' } : {}),
          }}
        >
          {title}
        </span>
        <span className={classes['end']}>
          {state?.mark === undefined || state.mark === null ? null : (
            <span className={classes['mark']} data-mark={state.mark}>
              <MarkIcon mark={state.mark} />
            </span>
          )}
          {/* Delete and the menu's Close are the keyboard's way; this is the pointer's. A fresh tab reads as a
              button for a new session, so it has none. */}
          {fresh ? null : (
            <span
              aria-hidden="true"
              className={classes['close']}
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            >
              <IconX size={12} stroke={1.5} />
            </span>
          )}
        </span>
      </div>
    </Tooltip>
  );
}
