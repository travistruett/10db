import { List, Stack, Text } from '@mantine/core';

/**
 * Before the first row the panel has only what has been heard so far, and the line that says how
 * it fills.
 */
export function HeardSoFar({ heard }: { readonly heard: readonly string[] }) {
  return (
    <Stack gap="sm">
      {heard.length === 0 ? null : (
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Heard so far
          </Text>
          <List size="sm" spacing={2} listStyleType="none" withPadding={false}>
            {heard.map((item) => (
              <List.Item key={item}>{item}</List.Item>
            ))}
          </List>
        </Stack>
      )}
      <Text size="sm" c="dimmed">
        Talk it through, or drop a document. The agent fills this in as things are decided.
      </Text>
    </Stack>
  );
}
