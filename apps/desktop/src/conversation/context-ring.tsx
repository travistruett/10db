import { Box, RingProgress, Stack, Text, Tooltip } from '@mantine/core';

/** Past this share the ring warns: the next turn of a chat continues in a fresh session. */
const WARN_AT_PCT = 70;

export interface ContextRingProps {
  /** How full the session's context is, 0 to 100; null before the agent has reported any. */
  readonly percent: number | null;
  /** More lines for the tooltip, after the percent (what the session cost). */
  readonly more?: readonly string[];
}

/** A very small ring of how much of the session's context is used, with the percent on hover. */
export function ContextRing({ percent, more = [] }: ContextRingProps) {
  if (percent === null) return null;
  const used = Math.min(100, Math.max(0, percent));
  const lines = [`${String(Math.round(used))}% of the context used`, ...more];
  return (
    <Tooltip
      multiline
      w={240}
      label={
        <Stack gap={2}>
          {lines.map((line) => (
            <Text key={line} size="xs">
              {line}
            </Text>
          ))}
        </Stack>
      }
    >
      <Box
        component="span"
        role="img"
        aria-label={lines.join('. ')}
        tabIndex={0}
        display="inline-flex"
      >
        <RingProgress
          size={18}
          thickness={3}
          sections={[{ value: used, color: used >= WARN_AT_PCT ? 'orange' : 'gray' }]}
        />
      </Box>
    </Tooltip>
  );
}
