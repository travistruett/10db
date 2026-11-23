import { Code, Group, Text } from '@mantine/core';

/** A builder message's `@` mentions as mono chips, and the line saying the agent has not read it yet. */
export function MentionChips({
  paths,
  waiting,
}: {
  readonly paths: readonly string[];
  readonly waiting: string | null;
}) {
  return (
    <>
      {paths.length === 0 ? null : (
        <Group gap={4} pt={6} aria-label="Mentioned files">
          {paths.map((path) => (
            // A long path wraps rather than scrolls, so the chip never becomes a scroll box.
            <Code key={path} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
              {path}
            </Code>
          ))}
        </Group>
      )}
      {waiting === null ? null : (
        <Text size="xs" c="dimmed" pt={4}>
          {waiting}
        </Text>
      )}
    </>
  );
}
