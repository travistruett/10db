import { Box, Spoiler } from '@mantine/core';
import { Markdown } from '../../conversation';

/** About eight lines of body text: enough to read the opening, short enough to leave the rest of the drawer in view. */
const COLLAPSED_PX = 180;

/**
 * An agent's long writing (a plan, a build report) drawn as markdown on the panel tone, cut to its opening
 * lines with Show All under it. The markdown renderer is the conversation's, so the text stays agent output:
 * raw HTML shows as text and links are https only.
 */
export function CollapsedMarkdown({ text }: { readonly text: string }) {
  return (
    <Box
      px="md"
      py="xs"
      fz="sm"
      bg="var(--tendb-color-panel)"
      style={{ borderRadius: 'var(--mantine-radius-md)', overflowWrap: 'anywhere' }}
    >
      <Spoiler maxHeight={COLLAPSED_PX} showLabel="Show All" hideLabel="Show Less" fz="sm">
        <Markdown text={text} />
      </Spoiler>
    </Box>
  );
}
