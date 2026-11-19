import { ActionIcon, Menu } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { MenuAction } from './menu-action';

export interface RowMenuProps {
  /** The page's name, which names the menu for assistive tech. */
  readonly label: string;
  readonly onTakeOut: () => void;
}

/** A queue row's own menu, beside its button: a button can't hold another control. */
export function RowMenu({ label, onTakeOut }: RowMenuProps) {
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
          label="Remove"
          byline="Take it out of this pass. Its changes move to its Board task."
          onClick={onTakeOut}
        />
      </Menu.Dropdown>
    </Menu>
  );
}
