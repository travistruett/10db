import { Box, Group, Text } from '@mantine/core';

export const ConnectionTone = { Works: 'works', NeedsYou: 'needs-you', Off: 'off' } as const;
export type ConnectionTone = (typeof ConnectionTone)[keyof typeof ConnectionTone];

const TONE_COLOR = {
  [ConnectionTone.Works]: 'teal',
  [ConnectionTone.NeedsYou]: 'yellow',
  [ConnectionTone.Off]: 'gray',
} as const satisfies Record<ConnectionTone, string>;

/** A connection's state: teal when it works, yellow when it needs the builder, gray when it is off. */
export function ConnectionStatus({
  tone,
  label,
}: {
  readonly tone: ConnectionTone;
  readonly label: string;
}) {
  const color = TONE_COLOR[tone];
  return (
    <Group gap={6} wrap="nowrap">
      <Box
        component="span"
        data-testid="connection-dot"
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
      <Text size="sm">{label}</Text>
    </Group>
  );
}
