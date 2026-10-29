import type { ProjectDto } from '@10db/contracts';
import { Button, Group, List, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import {
  useAllowNetworkHost,
  useNetworkHosts,
  useRemoveNetworkHost,
} from '../../daemon/network-host-queries';

/** The hosts a project's tasks and checks may reach: the same rules an Inbox card's Always Allow stores. */
export function NetworkHostsSection({ project }: { readonly project: ProjectDto }) {
  const hosts = useNetworkHosts(project.id);
  const allow = useAllowNetworkHost(project.id);
  const remove = useRemoveNetworkHost(project.id);
  const [host, setHost] = useState('');
  const list = hosts.data ?? [];

  function add() {
    allow.mutate(host, {
      onSuccess: () => {
        setHost('');
      },
    });
  }

  return (
    <Stack maw={640}>
      <Text size="sm" c="dimmed">
        Hosts this project's tasks and checks may reach.
      </Text>
      {hosts.isSuccess && list.length === 0 ? (
        <Text size="sm">No hosts are allowed yet.</Text>
      ) : (
        <List aria-label="Network hosts" listStyleType="none" spacing="xs">
          {list.map((entry) => (
            <List.Item
              key={entry.host}
              styles={{ itemWrapper: { width: '100%' }, itemLabel: { width: '100%' } }}
            >
              <Group justify="space-between" wrap="nowrap">
                <Text ff="monospace" size="sm">
                  {entry.host}
                </Text>
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  aria-label={`Remove ${entry.host}`}
                  loading={remove.isPending && remove.variables === entry.host}
                  onClick={() => {
                    remove.mutate(entry.host);
                  }}
                >
                  Remove
                </Button>
              </Group>
            </List.Item>
          ))}
        </List>
      )}
      {remove.error ? (
        <Text size="sm" c="red" role="alert">
          {remove.error.message}
        </Text>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Group align="flex-end" wrap="nowrap">
          <TextInput
            label="Host"
            placeholder="index.crates.io or *.crates.io"
            value={host}
            onChange={(e) => {
              setHost(e.currentTarget.value);
            }}
            style={{ flex: 1 }}
          />
          <Button type="submit" loading={allow.isPending}>
            Add Host
          </Button>
        </Group>
        {allow.error ? (
          <Text size="sm" c="red" role="alert" mt="xs">
            {allow.error.message}
          </Text>
        ) : null}
      </form>
    </Stack>
  );
}
