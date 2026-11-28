import type { FoundHostDto, ProjectDto, ProjectId } from '@10db/contracts';
import {
  ActionIcon,
  Button,
  Divider,
  Group,
  List,
  Paper,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconTrash, IconWand, IconWorld } from '@tabler/icons-react';
import { useState } from 'react';
import { EmptyState } from '../../shell/empty-state';
import {
  useAllowNetworkHost,
  useNetworkHosts,
  useRemoveNetworkHost,
  useScanNetworkHosts,
} from '../../daemon/network-host-queries';
import { networkHostSourceText } from './network-host-source';
import { SectionHeading } from './section-heading';

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
        Nothing new: every host the files name is allowed.
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      <Paper withBorder radius="md">
        <List aria-label="Hosts the files name" listStyleType="none">
          {found.map((entry, i) => (
            <List.Item
              key={entry.host}
              styles={{ itemWrapper: { width: '100%' }, itemLabel: { width: '100%' } }}
            >
              {i > 0 ? <Divider /> : null}
              <Group justify="space-between" wrap="nowrap" align="center" px="md" py="xs">
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
                  size="compact-sm"
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
      </Paper>
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
    <Stack gap="xl">
      <Stack gap="xs">
        <SectionHeading
          title="Allowed Hosts"
          line="What this project's tasks and checks may reach."
          help="The hosts this project's tasks and checks may reach: the same rules an Inbox card's Always Allow stores. A name can start with * to cover a domain."
          action={
            <form
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <Group align="flex-start" gap="xs" wrap="nowrap">
                <TextInput
                  aria-label="Host"
                  placeholder="index.crates.io or *.crates.io"
                  w={260}
                  value={host}
                  onChange={(e) => {
                    setHost(e.currentTarget.value);
                  }}
                />
                <Button type="submit" loading={allow.isPending}>
                  Add Host
                </Button>
                <Tooltip
                  position="left"
                  multiline
                  w={240}
                  label="Look Again: read the project's files for hosts they name that aren't allowed yet."
                >
                  <ActionIcon
                    variant="default"
                    size="input-sm"
                    aria-label="Look Again"
                    loading={scan.isPending}
                    onClick={() => {
                      scan.mutate();
                    }}
                  >
                    <IconWand size={18} stroke={1.5} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </form>
          }
        />
        {allow.error ? (
          <Text size="sm" c="red" role="alert">
            {allow.error.message}
          </Text>
        ) : null}
        {hosts.isError ? (
          <Text size="sm" c="red" role="alert">
            Couldn't load the hosts: {hosts.error.message}
          </Text>
        ) : hosts.isSuccess && list.length === 0 ? (
          <EmptyState icon={IconWorld} title="No Hosts Allowed Yet">
            Tasks and checks reach only the hosts you allow.
          </EmptyState>
        ) : (
          <Paper withBorder radius="md">
            <List aria-label="Network hosts" listStyleType="none">
              {list.map((entry, i) => (
                <List.Item
                  key={entry.host}
                  styles={{
                    itemWrapper: { width: '100%' },
                    itemLabel: { width: '100%' },
                  }}
                >
                  {i > 0 ? <Divider /> : null}
                  <Group justify="space-between" wrap="nowrap" align="center" px="md" py="xs">
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
                    <Tooltip label="Remove">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label={`Remove ${entry.host}`}
                        loading={remove.isPending && remove.variables === entry.host}
                        onClick={() => {
                          remove.mutate(entry.host);
                        }}
                      >
                        <IconTrash size={16} stroke={1.5} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </List.Item>
              ))}
            </List>
          </Paper>
        )}
      </Stack>

      {scan.isIdle ? null : (
        <Stack gap="xs">
          <SectionHeading
            title="Found in Project Files"
            line="Hosts the files name that aren't allowed yet."
          />
          {scan.isError ? (
            <Text size="sm" c="red" role="alert">
              Couldn't read the project's files: {scan.error.message}
            </Text>
          ) : null}
          {scan.isSuccess ? (
            <FoundHosts
              projectId={project.id}
              found={scan.data.filter((entry) => !list.some((h) => h.host === entry.host))}
            />
          ) : null}
        </Stack>
      )}
    </Stack>
  );
}
