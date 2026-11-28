import { visibleBlock } from '@10db/contracts';
import { Box, Stack, Text } from '@mantine/core';
import { useElementSize, useMergedRef } from '@mantine/hooks';
import { useLayoutEffect, useRef, useState } from 'react';

/** How many lines of a command show before the block scrolls. */
const COMMAND_BLOCK_LINES = 8;

/**
 * A command an agent asks to run, on its own in a monospace block, so no line of it reads as 10db's text or
 * Claude's. It is untrusted, so it is only ever rendered as text, with its line breaks kept and every other
 * hidden character (a tab, ESC, a bidi or zero-width character) shown as `\u{hex}`. When it is taller than the
 * block, a caption says how many lines it has, so a long tail can't scroll by unnoticed.
 */
export function CommandBlock({
  command,
  label = 'Command',
  maxLines = COMMAND_BLOCK_LINES,
}: {
  readonly command: string;
  /** What the block holds, for assistive technology. */
  readonly label?: string;
  /** How many lines show before the block scrolls. */
  readonly maxLines?: number;
}) {
  const { ref: sizeRef, width, height } = useElementSize<HTMLPreElement>();
  const block = useRef<HTMLPreElement>(null);
  const ref = useMergedRef(sizeRef, block);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = block.current;
    if (el === null) return;
    const next = el.scrollHeight > el.clientHeight + 1;
    setOverflows((was) => (was === next ? was : next));
  }, [command, width, height]);
  const lines = command.split('\n').length;
  return (
    <Stack gap={4}>
      <Box
        component="pre"
        ref={ref}
        aria-label={label}
        m={0}
        p="xs"
        fz="xs"
        style={{
          fontFamily: 'var(--mantine-font-family-monospace)',
          background: 'var(--mantine-color-body)',
          borderRadius: 'var(--mantine-radius-sm)',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          maxHeight: `calc(${String(maxLines)}lh + 2 * var(--mantine-spacing-xs))`,
          overflowY: 'auto',
        }}
      >
        {visibleBlock(command)}
      </Box>
      {overflows ? (
        <Text size="xs" c="dimmed">
          {String(lines)} {lines === 1 ? 'line' : 'lines'} · scroll to see all
        </Text>
      ) : null}
    </Stack>
  );
}
