import { ActionIcon, Group, HoverCard, Input } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';

export interface LabelWithHelpProps {
  readonly label: string;
  /** The `id` of the field this labels; the field takes no `label` of its own. */
  readonly htmlFor: string;
  /** The help card's content. */
  readonly children: ReactNode;
}

/**
 * A field label with an info button beside it, whose hover or focus opens a help card. The button
 * sits next to the label rather than in it, so the field's name stays just the label.
 */
export function LabelWithHelp({ label, htmlFor, children }: LabelWithHelpProps) {
  return (
    <Group gap={4} wrap="nowrap" mb={4}>
      <Input.Label htmlFor={htmlFor}>{label}</Input.Label>
      <HoverCard width={360} shadow="md" position="top-start" withArrow>
        <HoverCard.Target>
          <ActionIcon
            type="button"
            variant="subtle"
            color="gray"
            size="xs"
            aria-label={`About ${label.toLowerCase()}`}
          >
            <IconInfoCircle size={14} aria-hidden />
          </ActionIcon>
        </HoverCard.Target>
        <HoverCard.Dropdown>{children}</HoverCard.Dropdown>
      </HoverCard>
    </Group>
  );
}
