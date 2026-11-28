import { ActionIcon, Anchor, Box, Group, HoverCard, Stack, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { GuideOpener } from '../../shell/page-guide';

/** One choice a control offers, as its hover card explains it. */
export interface HelpOption {
  /** The option's name as the control shows it. */
  readonly label: string;
  /** What choosing it does, in about twelve words. */
  readonly line: string;
  /** A still of what it produces, no taller than 96 px, built from the app's own components. */
  readonly picture?: ReactNode;
}

/**
 * A small info button that opens the long version of a note. Plain, it holds a few paragraphs; for a control
 * whose options lead to different outcomes it holds a bold title and one line per option, each with an optional
 * still of what it produces, and may end in a link to the page's guide. One card per control, on its label or
 * column header, never one per option: a card per segment would open as the pointer crosses the control to click.
 * It opens on hover after 300 ms, on keyboard focus and on a tap, and Esc closes it. Nothing in it but the guide
 * link can be pressed; anything with buttons is a `Popover`.
 */
export function HelpHint({
  label,
  title,
  options,
  guide,
  children,
}: {
  /** What the note is about; names the button for assistive tech. */
  readonly label: string;
  readonly title?: string;
  readonly options?: readonly HelpOption[];
  /** The page's guide, opened from the card's last line. */
  readonly guide?: GuideOpener;
  /** Paragraphs of the note: strings, or any node. */
  readonly children?: ReactNode;
}) {
  return (
    <HoverCard
      width={340}
      position="bottom-start"
      withArrow
      openDelay={300}
      closeDelay={150}
      events={{ hover: true, focus: true, touch: true }}
      interactive={guide !== undefined}
    >
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
      <HoverCard.Dropdown p="md">
        <Stack gap="sm" fz="sm">
          {title === undefined ? null : (
            <Text size="sm" fw={600} c="var(--mantine-color-bright)">
              {title}
            </Text>
          )}
          {children}
          {options === undefined ? null : <OptionList options={options} />}
          {guide === undefined ? null : (
            <Group justify="flex-end" mt={2}>
              <Anchor component="button" type="button" size="xs" onClick={guide.onOpen}>
                {guide.label}
              </Anchor>
            </Group>
          )}
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** The options in two columns: names down one edge, what each does down the other. */
function OptionList({ options }: { readonly options: readonly HelpOption[] }) {
  return (
    <Box
      component="dl"
      m={0}
      style={{
        display: 'grid',
        gridTemplateColumns: 'max-content minmax(0, 1fr)',
        columnGap: 'var(--mantine-spacing-md)',
        rowGap: 'var(--mantine-spacing-sm)',
        alignItems: 'baseline',
      }}
    >
      {options.map((option) => (
        <Box key={option.label} style={{ display: 'contents' }}>
          <Text component="dt" size="xs" fw={600}>
            {option.label}
          </Text>
          <Stack component="dd" m={0} gap={6}>
            <Text size="xs" c="dimmed">
              {option.line}
            </Text>
            {option.picture === undefined ? null : (
              <Box mah={96} style={{ overflow: 'hidden', pointerEvents: 'none' }} inert aria-hidden>
                {option.picture}
              </Box>
            )}
          </Stack>
        </Box>
      ))}
    </Box>
  );
}

/** One paragraph of a help note. */
export function HelpText({ children }: { readonly children: ReactNode }) {
  return <Text size="xs">{children}</Text>;
}
