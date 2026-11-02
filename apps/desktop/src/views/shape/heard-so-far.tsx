import { List, Stack, Text } from '@mantine/core';

/**
 * Before the first proposal the sidebar has only what Claude has heard so far, and the one line
 * that says what Propose will do.
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
        Press Propose when you&apos;ve said enough. Claude will split what you said into goals and
        loose tasks.
      </Text>
    </Stack>
  );
}
