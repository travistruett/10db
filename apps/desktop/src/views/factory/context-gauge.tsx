import { Group, Progress, Text } from '@mantine/core';

export function ContextGauge({ pct }: { readonly pct: number | null }) {
  if (pct === null) return <Text size="sm">—</Text>;
  const value = Math.min(100, Math.max(0, pct));
  return (
    <Group gap="xs" wrap="nowrap">
      <Progress.Root w={80} size="sm">
        <Progress.Section value={value} aria-label="Context used" />
      </Progress.Root>
      <Text size="sm" ff="monospace">
        {`${String(Math.round(value))}%`}
      </Text>
    </Group>
  );
}
