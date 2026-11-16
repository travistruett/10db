import { ActionIcon, Button, Group, Menu, Tooltip } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import type { ReactNode } from 'react';

export interface SplitButtonProps {
  readonly children: ReactNode;
  readonly size?: 'xs' | 'sm';
  /** Why the action is off, said as its tooltip; null leaves it on. */
  readonly disabledReason?: string | null;
  readonly onClick: () => void;
  readonly leftSection?: ReactNode;
  /** Names the chevron for assistive tech, which can't see the arrow. */
  readonly menuLabel: string;
  /** `Menu.Item`s: the actions that share the primary action's place. */
  readonly menu: ReactNode;
}

/** A filled primary action with a chevron that opens its related actions. */
export function SplitButton({
  children,
  size = 'sm',
  disabledReason = null,
  onClick,
  leftSection,
  menuLabel,
  menu,
}: SplitButtonProps) {
  return (
    <Group wrap="nowrap" gap={0}>
      <Tooltip label={disabledReason ?? ''} disabled={disabledReason === null}>
        <Button
          size={size}
          leftSection={leftSection}
          disabled={disabledReason !== null}
          onClick={onClick}
          style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
        >
          {children}
        </Button>
      </Tooltip>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon
            size={size === 'xs' ? 'input-xs' : 'input-sm'}
            aria-label={menuLabel}
            // The seam is drawn in the body color, so it reads as a cut through one button.
            style={{
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
              borderLeft: '1px solid var(--mantine-color-body)',
            }}
          >
            <IconChevronDown size={16} stroke={1.5} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>{menu}</Menu.Dropdown>
      </Menu>
    </Group>
  );
}
