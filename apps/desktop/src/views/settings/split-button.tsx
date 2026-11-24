import { Button, Group, Menu } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import type { ReactNode, Ref } from 'react';
import { CountBadge } from '../../shell/count-badge';

/**
 * A section's primary action with a caret beside it that opens the section's other actions. The caret
 * carries `count`, the suggestions waiting behind its menu, so they show without opening it.
 */
export function SplitButton({
  label,
  onClick,
  menuLabel,
  count = 0,
  caretRef,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  /** The caret's name for assistive tech ("More ways to add an area"). */
  readonly menuLabel: string;
  readonly count?: number;
  /** The caret, for focus to come back to once what a menu item opened closes. */
  readonly caretRef?: Ref<HTMLButtonElement>;
  /** The menu's `Menu.Item`s. */
  readonly children: ReactNode;
}) {
  return (
    <Group gap={0} wrap="nowrap" data-keeps-drawer>
      <Button onClick={onClick} style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
        {label}
      </Button>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button
            ref={caretRef}
            aria-label={
              count > 0
                ? `${menuLabel}, ${String(count)} ${count === 1 ? 'suggestion' : 'suggestions'}`
                : menuLabel
            }
            px={count > 0 ? 8 : 10}
            style={{
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
              borderLeft:
                '1px solid color-mix(in srgb, var(--mantine-color-body) 35%, transparent)',
            }}
          >
            <Group gap={6} wrap="nowrap">
              {count > 0 ? <CountBadge count={count} /> : null}
              <IconChevronDown size={16} stroke={1.75} />
            </Group>
          </Button>
        </Menu.Target>
        <Menu.Dropdown>{children}</Menu.Dropdown>
      </Menu>
    </Group>
  );
}
