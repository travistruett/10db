import { Code, Stack, Text } from '@mantine/core';

/** A text Markdown can't draw, shown whole as plain text, so nothing in it is lost. */
export function PlainMarkdown({ text }: { readonly text: string }) {
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        Shown as plain text: it is too long or nests too deeply to draw.
      </Text>
      <Code block>{text}</Code>
    </Stack>
  );
}
