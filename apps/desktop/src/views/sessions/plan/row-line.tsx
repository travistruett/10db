import { ColorSwatch, Text, Tooltip, UnstyledButton } from '@mantine/core';
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
  /** The round's dot before the title; absent when the round left the row alone. */
  readonly dot?: { readonly label: string; readonly color: string } | null;
  readonly title: string;
  /** A goal's head: a card title. */
  readonly head?: boolean;
  /** Dimmed once Convert has made the row. */
  readonly dim?: boolean;
  /** Dimmed lines under the title: a goal's objective, what Convert made of the row. */
  readonly subs?: ReactNode;
  /** The facts at the right; hover or focus swaps them for `actions`. */
  readonly chips: ReactNode;
  readonly actions?: ReactNode;
  /** The size column: a size, or a goal's lane time. */
  readonly trailing?: string | undefined;
  readonly section?: string;
  readonly opened: boolean;
  readonly regionId: string;
  readonly tabbable: boolean;
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly onToggle: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * One line of the Plan: the title as a button that covers the row, then its facts, which hover or
 * keyboard focus swap for the row's actions, then the size column.
 */
export function RowLine({
  dot,
  title,
  head = false,
  dim = false,
  subs,
  chips,
  actions,
  trailing,
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
      {dot === undefined || dot === null ? null : (
        <Tooltip label={dot.label}>
          <ColorSwatch
            size={6}
            color={`var(--mantine-color-${dot.color}-filled)`}
            aria-label={dot.label}
            role="img"
            className={classes['dot']}
          />
        </Tooltip>
      )}
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
          fw={head ? 600 : 400}
          lh="20px"
          {...(dim ? { c: 'dimmed' } : head ? { c: 'bright' } : {})}
          {...(opened ? {} : { lineClamp: 2 })}
        >
          {title}
        </Text>
      </UnstyledButton>
      <div className={classes['slot']}>
        <div className={classes['chips']}>{chips}</div>
        {actions === undefined ? null : <div className={classes['actions']}>{actions}</div>}
      </div>
      <Text fz={12} c="dimmed" className={classes['trail']}>
        {trailing}
      </Text>
      {subs === undefined ? null : <div className={classes['subs']}>{subs}</div>}
    </div>
  );
}
