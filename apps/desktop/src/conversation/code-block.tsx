import { CodeHighlight } from '@mantine/code-highlight';
import { Box, Text } from '@mantine/core';

/**
 * The most code a fence highlights, in UTF-16 code units. Shiki runs in render, and some grammars
 * on the JavaScript engine take quadratic time on a long input, so past this the code is plain.
 */
const HIGHLIGHT_MAX_CHARS = 50_000;
/** The longest line a highlighted fence may hold; one line past it draws the whole fence plain. */
const HIGHLIGHT_MAX_LINE_CHARS = 2_000;

/** Whether `code` is small enough to highlight: under both limits. */
function highlightable(code: string): boolean {
  if (code.length > HIGHLIGHT_MAX_CHARS) return false;
  let start = 0;
  for (let end = code.indexOf('\n'); end !== -1; end = code.indexOf('\n', start)) {
    if (end - start > HIGHLIGHT_MAX_LINE_CHARS) return false;
    start = end + 1;
  }
  return code.length - start <= HIGHLIGHT_MAX_LINE_CHARS;
}

/**
 * A fence: highlighted on `bg_0` inside a 1 px `bg_2` border, its language named at the top right
 * beside its Copy control. It never caps its height, and a long line scrolls sideways. Code past
 * the highlight limits draws plain, its language still named.
 */
export function CodeBlock({
  code,
  language,
}: {
  readonly code: string;
  readonly language: string | null;
}) {
  const name = language?.trim().toLowerCase() ?? '';
  const highlighted = name !== '' && highlightable(code);
  return (
    <Box pos="relative" my={6}>
      <CodeHighlight
        code={code}
        {...(highlighted ? { language: name } : {})}
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
