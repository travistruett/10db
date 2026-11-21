import { ColorSwatch, Text, Tooltip, UnstyledButton } from '@mantine/core';
import type { KeyboardEvent, ReactNode, Ref } from 'react';
import classes from './plan-rows.module.css';

/** Marks a row's button, so ↑/↓ finds its siblings. */
export const ROW_ATTRIBUTE = 'data-shape-row';

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
  /** The state dot before the title; absent for a goal's task, whose state is its goal's. */
  readonly dot?: { readonly label: string; readonly color: string };
  readonly title: string;
  /** A goal's head: the strongest text of the panel. */
  readonly strong?: boolean;
  /** Dimmed once Convert has made the row. */
  readonly dim?: boolean;
  /** Dimmed lines under the title: a goal's objective, what Convert made of the row. */
  readonly subs?: ReactNode;
  /** The chips at the right; hover or focus swaps them for `actions`. */
  readonly chips: ReactNode;
  readonly actions?: ReactNode;
  /** A fact that stays at the right edge, such as a goal's lane time. */
  readonly trailing?: ReactNode;
  readonly section?: string;
  readonly opened: boolean;
  readonly regionId: string;
  readonly tabbable: boolean;
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly onToggle: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * One line of the Plan: a dot, the title as a button that covers the row, and at the right its chips,
 * which hover or keyboard focus swap for the row's actions.
 */
export function RowLine({
  dot,
  title,
  strong = false,
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
      {dot === undefined ? null : (
        <Tooltip label={dot.label}>
          <ColorSwatch
            size={8}
            color={`var(--mantine-color-${dot.color}-filled)`}
            aria-label={dot.label}
            role="img"
            mt={7}
            style={{ flex: 'none' }}
          />
        </Tooltip>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
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
          style={{ display: 'block', width: '100%', textAlign: 'left' }}
        >
          <Text
            size="sm"
            fw={strong ? 500 : 400}
            {...(dim ? { c: 'dimmed' } : strong ? { c: 'bright' } : {})}
            {...(opened ? {} : { lineClamp: 2 })}
          >
            {title}
          </Text>
        </UnstyledButton>
        {subs}
      </div>
      <div className={classes['slot']}>
        <div className={classes['chips']}>{chips}</div>
        {actions === undefined ? null : <div className={classes['actions']}>{actions}</div>}
      </div>
      {trailing}
    </div>
  );
}
