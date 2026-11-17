import { Paper, Spoiler, Text } from '@mantine/core';
import { useId } from 'react';
import { Markdown } from '../../conversation/markdown';

/** How tall a brief is drawn before Show all, in px: about six lines. */
const FOLDED_PX = 132;

/**
 * The brief a task was started from, drawn as its markdown in a card of its own: it is what the task was
 * asked, not a message the builder sent, so it never takes the builder's bubble.
 */
export function BriefCard({ text }: { readonly text: string }) {
  const titleId = useId();
  return (
    <Paper component="section" aria-labelledby={titleId} withBorder radius="md" px="md" py="sm">
      <Text id={titleId} size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
        Brief
      </Text>
      <Spoiler maxHeight={FOLDED_PX} showLabel="Show all" hideLabel="Show less">
        <Markdown text={text} />
      </Spoiler>
    </Paper>
  );
}
