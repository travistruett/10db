import { Alert, Box, Button, Code, Group, Stack } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ErrorComponentProps } from '@tanstack/react-router';

/**
 * What the window shows when a crash escapes every view's boundary. The window has no title bar, so the
 * top strip stays clear of the traffic lights and still drags the window.
 */
export function AppError({ error, reset }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Box h="100vh" style={{ display: 'flex', flexDirection: 'column' }}>
      <Box h={48} data-tauri-drag-region style={{ flex: 'none' }} />
      <Box p="xl" pt="md">
        <Alert
          color="red"
          icon={<IconAlertTriangle size={20} stroke={1.5} />}
          title="10db hit an error it couldn't recover from"
        >
          <Stack gap="sm" align="flex-start">
            <Code block>{message}</Code>
            <Group gap="xs">
              <Button size="sm" onClick={reset}>
                Try Again
              </Button>
              <Button
                size="sm"
                variant="default"
                onClick={() => {
                  window.location.reload();
                }}
              >
                Reload Window
              </Button>
            </Group>
          </Stack>
        </Alert>
      </Box>
    </Box>
  );
}
