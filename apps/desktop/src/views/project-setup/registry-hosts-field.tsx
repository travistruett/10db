import type { FoundHostDto } from '@10db/contracts';
import { List, Stack, Text } from '@mantine/core';

/**
 * The hosts the folder's lockfiles, package manager settings and toolchain files name, which the
 * project allows once it is added: its tasks and checks reach them with no card to answer.
 */
export function RegistryHostsField({ hosts }: { readonly hosts: readonly FoundHostDto[] }) {
  if (hosts.length === 0) return null;
  return (
    <Stack gap="xs">
      <Text size="sm" fw={500}>
        Network hosts
      </Text>
      <Text size="xs" c="dimmed">
        The project's own files name these package registries, so it allows them. You can change
        them later in Settings.
      </Text>
      <List
        aria-label="Network hosts the project will allow"
        listStyleType="none"
        spacing={2}
        styles={{ itemWrapper: { width: '100%' }, itemLabel: { width: '100%' } }}
      >
        {hosts.map(({ host, file }) => (
          <List.Item key={host}>
            <Text span ff="monospace" size="sm">
              {host}
            </Text>
            <Text span size="xs" c="dimmed" ml="xs">
              Found in {file}
            </Text>
          </List.Item>
        ))}
      </List>
    </Stack>
  );
}
