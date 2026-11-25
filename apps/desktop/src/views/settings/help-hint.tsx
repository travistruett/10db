import { ActionIcon, HoverCard, Stack, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';

/** A small info button that opens the long version of a note: a setting's per-agent detail, say. */
export function HelpHint({
  label,
  children,
}: {
  /** What the note is about; names the button for assistive tech. */
  readonly label: string;
  /** Paragraphs of the note: strings, or any node. */
  readonly children: ReactNode;
}) {
  return (
    <HoverCard width={360} position="top-start" withArrow openDelay={150}>
      <HoverCard.Target>
        <ActionIcon
          type="button"
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={`About ${label}`}
        >
          <IconInfoCircle size={16} aria-hidden />
        </ActionIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Stack gap="xs" fz="sm">
          {children}
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** One paragraph of a help note. */
export function HelpText({ children }: { readonly children: ReactNode }) {
  return <Text size="xs">{children}</Text>;
}
