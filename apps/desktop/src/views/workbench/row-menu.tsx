import { ActionIcon, Menu } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { MenuAction } from './menu-action';

export interface RowMenuProps {
  /** The page's name, which names the menu for assistive tech. */
  readonly area: string;
  readonly onTakeOut: () => void;
}

/** A queue row's own menu, beside its button: a button can't hold another control. */
export function RowMenu({ area, onTakeOut }: RowMenuProps) {
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          mx={4}
          aria-label={`More actions for ${area}`}
          style={{ flex: 'none' }}
        >
          <IconDots size={16} stroke={1.5} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <MenuAction
          label="Remove"
          byline="Take this page out of the pass. Its files go back; its work is saved."
          onClick={onTakeOut}
        />
      </Menu.Dropdown>
    </Menu>
  );
}
