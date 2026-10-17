import { PROTOCOL_VERSION } from '@10db/contracts';
import { Center, Stack, Text, Title } from '@mantine/core';

export function VersionMismatch({ daemonVersion }: { readonly daemonVersion: number }) {
  return (
    <Center h="100vh">
      <Stack align="center" maw={480}>
        <Title order={2}>10db needs a restart</Title>
        <Text ta="center">
          This window speaks protocol version {PROTOCOL_VERSION}, but the running daemon speaks
          version {daemonVersion}. Quit 10db from the menu bar and open it again, so both come from
          the same build.
        </Text>
      </Stack>
    </Center>
  );
}
