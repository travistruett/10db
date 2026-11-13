import { Box, Group, Text } from '@mantine/core';

/** How a connection stands: it works, it needs the builder, or it is switched off. */
export const ConnectionTone = { Works: 'works', NeedsYou: 'needs-you', Off: 'off' } as const;
export type ConnectionTone = (typeof ConnectionTone)[keyof typeof ConnectionTone];

const DOT_COLOR: Record<ConnectionTone, string> = {
  [ConnectionTone.Works]: 'var(--mantine-color-teal-6)',
  [ConnectionTone.NeedsYou]: 'var(--mantine-color-yellow-6)',
  [ConnectionTone.Off]: 'var(--mantine-color-gray-6)',
};

/** A status dot and its words. The dot is colour only, so the words always carry the meaning. */
export function ConnectionStatus({
  tone,
  label,
}: {
  readonly tone: ConnectionTone;
  readonly label: string;
}) {
  return (
    <Group gap={6} wrap="nowrap">
      <Box
        aria-hidden
        w={8}
        h={8}
        style={{ borderRadius: '50%', flexShrink: 0, background: DOT_COLOR[tone] }}
      />
      <Text size="sm">{label}</Text>
    </Group>
  );
}
