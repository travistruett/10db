import type { PassFileChange } from '@10db/contracts';
import { Box, Group, Text } from '@mantine/core';

/** The files a turn changed, each with its lines added and removed. */
export function TurnFiles({ files }: { readonly files: readonly PassFileChange[] }) {
  if (files.length === 0) return null;
  return (
    <Box
      component="ul"
      aria-label="Files this turn changed"
      m={0}
      p={0}
      style={{ listStyle: 'none' }}
    >
      {files.map((file) => (
        <Group component="li" key={file.path} gap="xs" wrap="nowrap">
          <Text size="xs" ff="monospace" truncate="start" style={{ minWidth: 0 }}>
            {file.path}
          </Text>
          <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 'none' }}>
            +{file.added} −{file.removed}
          </Text>
        </Group>
      ))}
    </Box>
  );
}
