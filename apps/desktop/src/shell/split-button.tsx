import { ActionIcon, Button, Group, Menu, Tooltip } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import type { ReactNode } from 'react';

export interface SplitButtonProps {
  readonly children: ReactNode;
  readonly size?: 'xs' | 'sm';
  /** Why the action is off, said as its tooltip; null leaves it on. */
  readonly disabledReason?: string | null;
  /** The primary action is under way. */
  readonly loading?: boolean;
  readonly onClick: () => void;
  readonly leftSection?: ReactNode;
  /** What the action does, said as its tooltip while it is on. */
  readonly hint?: string;
  /** Names the chevron for assistive tech, which can't see the arrow, and is its tooltip. */
  readonly menuLabel: string;
  /** `Menu.Item`s: the actions that share the primary action's place. */
  readonly menu: ReactNode;
}

/** A filled primary action with a chevron that opens its related actions. */
export function SplitButton({
  children,
  size = 'sm',
  disabledReason = null,
  loading = false,
  onClick,
  leftSection,
  hint,
  menuLabel,
  menu,
}: SplitButtonProps) {
  const label = disabledReason ?? hint ?? null;
  return (
    <Group wrap="nowrap" gap={0}>
      <Tooltip label={label ?? ''} disabled={label === null}>
        <Button
          size={size}
          leftSection={leftSection}
          disabled={disabledReason !== null}
          loading={loading}
          onClick={onClick}
          style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
        >
          {children}
        </Button>
      </Tooltip>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Tooltip label={menuLabel} disabled={disabledReason !== null}>
            <ActionIcon
              size={size === 'xs' ? 'input-xs' : 'input-sm'}
              aria-label={menuLabel}
              disabled={disabledReason !== null}
              // The seam is drawn in the body color, so it reads as a cut through one button.
              style={{
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                borderLeft: '1px solid var(--mantine-color-body)',
              }}
            >
              <IconChevronDown size={16} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown>{menu}</Menu.Dropdown>
      </Menu>
    </Group>
  );
}
