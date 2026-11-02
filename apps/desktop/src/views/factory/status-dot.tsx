import { Box, type MantineColor } from '@mantine/core';

/** A small filled dot in a DESIGN.md status color; decorative, the words beside it carry the meaning. */
export function StatusDot({ color }: { readonly color: MantineColor }) {
  return (
    <Box
      component="span"
      data-testid="status-dot"
      data-color={color}
      aria-hidden
      w={8}
      h={8}
      style={{
        display: 'inline-block',
        flex: 'none',
        borderRadius: '50%',
        background: `var(--mantine-color-${color}-filled)`,
      }}
    />
  );
}
