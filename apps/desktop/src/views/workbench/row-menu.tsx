import { ActionIcon, Menu } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { MenuAction } from './menu-action';

export interface RowMenuProps {
  /** The page's name, which names the menu for assistive tech. */
  readonly label: string;
  readonly onDiscard: () => void;
}

/** A queue row's own menu, beside its button: a button can't hold another control. */
export function RowMenu({ label, onDiscard }: RowMenuProps) {
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={`More actions for ${label}`}
          style={{ flex: 'none' }}
        >
          <IconDots size={16} stroke={1.5} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <MenuAction
          label="Discard"
          byline="Delete its changes and take it out of this pass."
          color="red"
          onClick={onDiscard}
        />
      </Menu.Dropdown>
    </Menu>
  );
}
