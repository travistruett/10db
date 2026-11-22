import { Text, Tooltip, UnstyledButton } from '@mantine/core';
import type { KeyboardEvent, ReactNode, Ref } from 'react';
import classes from './plan-rows.module.css';

/** Marks a row's button, so ↑/↓ finds its siblings. */
export const ROW_ATTRIBUTE = 'data-shape-row';

/** The one row of the panel that is open, and whether it is being edited. */
export interface OpenRow {
  readonly id: string;
  readonly editing: boolean;
}

/** Moves focus to the next or previous row button of the Plan; false at either end. */
export function moveRowFocus(from: HTMLElement, delta: 1 | -1): boolean {
  const list = from.closest('[aria-label="Plan rows"]');
  if (list === null) return false;
  const rows = [...list.querySelectorAll<HTMLElement>(`[${ROW_ATTRIBUTE}]`)];
  const next = rows[rows.indexOf(from) + delta];
  if (next === undefined) return false;
  next.focus();
  return true;
}

export interface RowLineProps {
  readonly title: string;
  /** A goal's head: a card title. */
  readonly head?: boolean;
  /** Dimmed once Convert has made the row. */
  readonly dim?: boolean;
  /** Dimmed lines under the title: a goal's objective, what Convert made of the row. */
  readonly subs?: ReactNode;
  /** The facts at the right; the opened row shows `actions` in their place. */
  readonly chips: ReactNode;
  readonly actions?: ReactNode;
  /** The size column: a size, or a goal's lane time. */
  readonly trailing?: string | undefined;
  /** The size column's words on hover. */
  readonly trailingLabel?: string | undefined;
  readonly section?: string;
  readonly opened: boolean;
  readonly regionId: string;
  readonly tabbable: boolean;
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly onToggle: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * One line of the Plan: the title as a button that covers the row, then its facts, which the opened row
 * shows its actions in place of, then the size column.
 */
export function RowLine({
  title,
  head = false,
  dim = false,
  subs,
  chips,
  actions,
  trailing,
  trailingLabel,
  section,
  opened,
  regionId,
  tabbable,
  buttonRef,
  onToggle,
  onKeyDown,
}: RowLineProps) {
  return (
    <div className={classes['row']}>
      <UnstyledButton
        ref={buttonRef}
        className={classes['hit']}
        {...{ [ROW_ATTRIBUTE]: '' }}
        {...(section === undefined ? {} : { 'data-section': section })}
        aria-expanded={opened}
        aria-controls={opened ? regionId : undefined}
        tabIndex={tabbable ? 0 : -1}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        style={{ display: 'block', minWidth: 0, textAlign: 'left' }}
      >
        <Text
          fz={14}
          fw={head || opened ? 600 : 400}
          lh="20px"
          {...(dim ? { c: 'dimmed' } : head || opened ? { c: 'bright' } : {})}
          {...(opened ? {} : { lineClamp: 2 })}
        >
          {title}
        </Text>
      </UnstyledButton>
      <div className={classes['slot']}>
        {opened && actions !== undefined ? (
          <div className={classes['actions']}>{actions}</div>
        ) : (
          <div className={classes['chips']}>{chips}</div>
        )}
      </div>
      {/* An opened row says its time in its facts line, so its title keeps the width. */}
      <Tooltip label={trailingLabel} disabled={trailingLabel === undefined || opened}>
        <Text fz={12} c="dimmed" className={classes['trail']}>
          {opened ? null : trailing}
        </Text>
      </Tooltip>
      {subs === undefined ? null : <div className={classes['subs']}>{subs}</div>}
    </div>
  );
}
