import { UnstyledButton } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { CSSProperties } from 'react';
import classes from './create-button.module.css';

/** The class a row wears while it stands for a new thing not yet made, so it reads as this button's slot. */
export const CREATE_SLOT_CLASS = classes['slot'] ?? '';

/**
 * The button that makes a new thing in a list (Add Page, Add Task): a dashed slot with a + and the thing's name in
 * Title Case. Hovered it fills and its + takes the primary colour; pressed it sinks a pixel. A shortcut shows at the
 * end while it is hovered or focused.
 */
export function CreateButton({
  label,
  onClick,
  disabled = false,
  shortcut,
  hoverTone,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** The keys that do the same, such as ⌘T. */
  readonly shortcut?: string;
  /** The fill under the pointer where the list is not on a panel's tone, such as a board column's card tone. */
  readonly hoverTone?: string;
}) {
  const style =
    hoverTone === undefined ? undefined : ({ '--create-hover': hoverTone } as CSSProperties);
  return (
    <UnstyledButton
      className={classes['button']}
      onClick={onClick}
      disabled={disabled}
      style={style}
    >
      <span className={classes['plus']} aria-hidden="true">
        <IconPlus size={13} stroke={2} />
      </span>
      <span className={classes['label']}>{label}</span>
      {shortcut === undefined ? null : (
        <span className={classes['shortcut']} aria-hidden="true">
          {shortcut}
        </span>
      )}
    </UnstyledButton>
  );
}
