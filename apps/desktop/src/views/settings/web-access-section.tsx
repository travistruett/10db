import type { FoundHostDto, ProjectDto, ProjectId, WebHostSource } from '@10db/contracts';
import { Button, Group, List, Stack, Switch, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import {
  useAddWebHost,
  useRemoveWebHost,
  useScanWebHosts,
  useSetWebSearch,
  useWebHosts,
  useWebSearch,
} from '../../daemon/web-access-queries';
import { networkHostSourceText } from './network-host-source';
import { SettingRow, SettingsCard } from './setting-row';

const SEARCH_LABEL = 'Lanes search the web without a card';

function sourceText(source: WebHostSource): string {
  return source.kind === 'start' ? 'On every new list' : networkHostSourceText(source);
}

function WebSearchSwitch({ projectId }: { readonly projectId: ProjectId }) {
  const status = useWebSearch(projectId);
  const set = useSetWebSearch(projectId);
  return (
    <SettingsCard>
      <SettingRow
        label={SEARCH_LABEL}
        description="A search query is text the lane chose, and it goes to the search provider. Off, each search raises a card. Applies to the next search."
      >
        <Group justify="flex-end">
          <Switch
            aria-label={SEARCH_LABEL}
            checked={status.data?.enabled ?? false}
            disabled={status.data === undefined}
            onChange={(e) => {
              set.mutate(e.currentTarget.checked);
            }}
          />
        </Group>
      </SettingRow>
    </SettingsCard>
  );
}

/**
 * The documentation hosts a look at the project's manifests found that aren't listed, each with an
 * Add the builder presses by name. A lane may have written those files, so nothing is added unseen.
 */
function FoundHosts({
  projectId,
  found,
}: {
  readonly projectId: ProjectId;
  readonly found: readonly FoundHostDto[];
}) {
  const add = useAddWebHost(projectId);
  if (found.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        The project’s files name no other host.
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      <Text size="sm">
        The project’s dependencies are documented on these hosts. Add the ones you expect.
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
                {add.isError && add.variables === entry.host ? (
                  <Text size="xs" c="red" role="alert">
                    {add.error.message}
                  </Text>
                ) : null}
              </Stack>
              <Button
                size="xs"
                variant="default"
                aria-label={`Add ${entry.host}`}
                loading={add.isPending && add.variables === entry.host}
                onClick={() => {
                  add.mutate(entry.host);
                }}
              >
                Add
              </Button>
            </Group>
          </List.Item>
        ))}
      </List>
    </Stack>
  );
}

/** A project's web search switch and read list: the hosts WebFetch reads with no card, stored apart from the hosts commands may reach. */
export function WebAccessSection({ project }: { readonly project: ProjectDto }) {
  const hosts = useWebHosts(project.id);
  const add = useAddWebHost(project.id);
  const remove = useRemoveWebHost(project.id);
  const scan = useScanWebHosts(project.id);
  const [host, setHost] = useState('');
  const list = hosts.data ?? [];

  return (
    <Stack maw={640}>
      <WebSearchSwitch projectId={project.id} />
      <Text size="sm" c="dimmed">
        The read list: hosts whose pages lanes read with no card. Anything a lane puts in an address
        reaches that host, so list hosts you trust with it. Any other host raises a card.
      </Text>
      {hosts.isError ? (
        <Text size="sm" c="red" role="alert">
          Couldn't load the read list: {hosts.error.message}
        </Text>
      ) : hosts.isSuccess && list.length === 0 ? (
        <Text size="sm">No hosts are on the read list.</Text>
      ) : (
        <List aria-label="Read list" listStyleType="none" spacing="xs">
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
                    {sourceText(entry.source)}
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
          add.mutate(host, {
            onSuccess: () => {
              setHost('');
            },
          });
        }}
      >
        <Group align="flex-end" wrap="nowrap">
          <TextInput
            label="Host"
            placeholder="docs.rs"
            value={host}
            onChange={(e) => {
              setHost(e.currentTarget.value);
            }}
            style={{ flex: 1 }}
          />
          <Button type="submit" loading={add.isPending}>
            Add Host
          </Button>
        </Group>
        {add.error ? (
          <Text size="sm" c="red" role="alert" mt="xs">
            {add.error.message}
          </Text>
        ) : null}
      </form>
    </Stack>
  );
}
