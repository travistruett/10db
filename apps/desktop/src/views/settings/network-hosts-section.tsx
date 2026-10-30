import type { FoundHostDto, ProjectDto, ProjectId } from '@10db/contracts';
import { Button, Group, List, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import {
  useAllowNetworkHost,
  useNetworkHosts,
  useRemoveNetworkHost,
  useScanNetworkHosts,
} from '../../daemon/network-host-queries';
import { networkHostSourceText } from './network-host-source';

/**
 * The hosts a look at the project's files found that are not allowed, each with its file and an Allow
 * the builder presses by name. A lane may have written those files, so nothing here is allowed unseen.
 */
function FoundHosts({
  projectId,
  found,
}: {
  readonly projectId: ProjectId;
  readonly found: readonly FoundHostDto[];
}) {
  const allow = useAllowNetworkHost(projectId);
  if (found.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        The project's files name no host that isn't allowed.
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      <Text size="sm">
        The project's files name these hosts, which aren't allowed. Allow the ones you expect.
      </Text>
      <List aria-label="Hosts the files name" listStyleType="none" spacing="xs">
        {found.map((entry) => (
          <List.Item
            key={entry.host}
            styles={{ itemWrapper: { width: '100%' }, itemLabel: { width: '100%' } }}
          >
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Stack gap={0}>
                <Text ff="monospace" size="sm">
                  {entry.host}
                </Text>
                <Text size="xs" c="dimmed">
                  {networkHostSourceText({ kind: 'file', file: entry.file })}
                </Text>
                {allow.isError && allow.variables === entry.host ? (
                  <Text size="xs" c="red" role="alert">
                    {allow.error.message}
                  </Text>
                ) : null}
              </Stack>
              <Button
                size="xs"
                variant="default"
                aria-label={`Allow ${entry.host}`}
                loading={allow.isPending && allow.variables === entry.host}
                onClick={() => {
                  allow.mutate(entry.host);
                }}
              >
                Allow
              </Button>
            </Group>
          </List.Item>
        ))}
      </List>
    </Stack>
  );
}

/** The hosts a project's tasks and checks may reach: the same rules an Inbox card's Always Allow stores. */
export function NetworkHostsSection({ project }: { readonly project: ProjectDto }) {
  const hosts = useNetworkHosts(project.id);
  const allow = useAllowNetworkHost(project.id);
  const remove = useRemoveNetworkHost(project.id);
  const scan = useScanNetworkHosts(project.id);
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
      {hosts.isError ? (
        <Text size="sm" c="red" role="alert">
          Couldn't load the hosts: {hosts.error.message}
        </Text>
      ) : hosts.isSuccess && list.length === 0 ? (
        <Text size="sm">No hosts are allowed yet.</Text>
      ) : (
        <List aria-label="Network hosts" listStyleType="none" spacing="xs">
          {list.map((entry) => (
            <List.Item
              key={entry.host}
              styles={{ itemWrapper: { width: '100%' }, itemLabel: { width: '100%' } }}
            >
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={0}>
                  <Text ff="monospace" size="sm">
                    {entry.host}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {networkHostSourceText(entry.source)}
                  </Text>
                  {remove.isError && remove.variables === entry.host ? (
                    <Text size="xs" c="red" role="alert">
                      {remove.error.message}
                    </Text>
                  ) : null}
                </Stack>
                <Button
                  size="xs"
                  variant="default"
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
      <Group align="center">
        <Button
          variant="default"
          size="xs"
          loading={scan.isPending}
          onClick={() => {
            scan.mutate();
          }}
        >
          Look Again
        </Button>
        {scan.isError ? (
          <Text size="sm" c="red" role="alert">
            Couldn't read the project's files: {scan.error.message}
          </Text>
        ) : null}
      </Group>
      {scan.isSuccess ? (
        <FoundHosts
          projectId={project.id}
          found={scan.data.filter((entry) => !list.some((h) => h.host === entry.host))}
        />
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
