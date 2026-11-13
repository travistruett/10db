import { CodeHighlight } from '@mantine/code-highlight';
import { Box, Text } from '@mantine/core';

/**
 * A fence: highlighted on `bg_0` inside a 1 px `bg_2` border, its language named at the top right
 * beside its Copy control. It never caps its height, and a long line scrolls sideways.
 */
export function CodeBlock({
  code,
  language,
}: {
  readonly code: string;
  readonly language: string | null;
}) {
  const name = language?.trim().toLowerCase() ?? '';
  return (
    <Box pos="relative" my={6}>
      <CodeHighlight
        code={code}
        {...(name === '' ? {} : { language: name })}
        withBorder
        withCopyButton
        copyLabel="Copy"
        copiedLabel="Copied"
      />
      {name !== '' && (
        <Text
          size="xs"
          c="dimmed"
          pos="absolute"
          top={6}
          right={40}
          style={{ pointerEvents: 'none' }}
        >
          {name}
        </Text>
      )}
    </Box>
  );
}
