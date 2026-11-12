import { Menu, Text } from '@mantine/core';
import { useId, type ReactNode } from 'react';

export interface MenuActionProps {
  readonly label: string;
  /** One short line under the label saying what the action does. */
  readonly byline: string;
  readonly color?: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

/** A menu item with a line under its label saying what it does; the line is the item's description. */
export function MenuAction({
  label,
  byline,
  color,
  disabled,
  onClick,
}: MenuActionProps): ReactNode {
  const id = useId();
  return (
    <Menu.Item
      {...(color === undefined ? {} : { color })}
      disabled={disabled === true}
      onClick={onClick}
      aria-label={label}
      aria-describedby={id}
    >
      <Text size="sm" c="inherit">
        {label}
      </Text>
      <Text id={id} size="xs" c="dimmed" maw={300}>
        {byline}
      </Text>
    </Menu.Item>
  );
}
