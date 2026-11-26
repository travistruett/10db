import { Center, Stack, Text, Title } from '@mantine/core';
import { removedBy } from './device-session';

/**
 * What a phone shows when it holds no device token: removed by the Mac, or never paired (or forgotten here). The
 * only way back is a new code from the Mac, so there is nothing to press.
 */
export function UnpairedPage() {
  const host = removedBy();
  return (
    <Center h="100dvh" p="lg">
      <Stack gap="sm" maw={420}>
        <Title order={2}>{host === null ? 'Not paired' : 'Removed'}</Title>
        <Text size="sm">
          {host === null
            ? 'This phone is not paired with a Mac. On the Mac, open Settings › Devices and press Pair a Device, then scan the picture.'
            : `This device was removed from ${host}. Pair it again to reconnect.`}
        </Text>
      </Stack>
    </Center>
  );
}
