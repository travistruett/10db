import { McpTransport, type RepoMcpServerDto } from '@10db/contracts';
import { Badge, Button, Code, Collapse, Group, Modal, Stack, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { visibleText } from './visible-text';

/** Commands that fetch a package when they start. */
const DOWNLOADERS = ['npx', 'bunx', 'uvx'];

function downloadsAtStart(server: RepoMcpServerDto): boolean {
  const command = (server.command ?? '').split('/').at(-1) ?? '';
  return DOWNLOADERS.includes(command) || (command === 'pnpm' && server.args[0] === 'dlx');
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Group gap="md" align="flex-start" wrap="nowrap">
      <Text size="sm" c="dimmed" w={170} style={{ flex: 'none' }}>
        {label}
      </Text>
      <div style={{ minWidth: 0 }}>{children}</div>
    </Group>
  );
}

/**
 * What turning a repo server On approves, from its review: what it runs or connects to, which hosts it
 * reaches and what it reads from the builder's environment. The approval card's own text sits behind Full
 * Details. Repo text is shown with unsafe characters made visible.
 */
export function RepoMcpConfirm({
  server,
  loading,
  error,
  onConfirm,
  onCancel,
}: {
  readonly server: RepoMcpServerDto;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const [full, setFull] = useState(false);
  const stdio = server.transport === McpTransport.Stdio;
  const runs = [server.command ?? '', ...server.args].map(visibleText).join(' ');
  return (
    <Modal
      opened
      onClose={onCancel}
      title={`Turn On ${visibleText(server.name)}?`}
      centered
      size="md"
    >
      <Stack gap="md">
        <Text size="sm">From this repo's .mcp.json. Sessions in this project get its tools.</Text>
        <Stack gap="xs">
          {stdio ? (
            <Fact label="Runs">
              <Code>{runs}</Code>
            </Fact>
          ) : (
            <Fact label="Connects to">
              <Code>{visibleText(server.url ?? '')}</Code>
            </Fact>
          )}
          {stdio ? (
            <Fact label="Network">
              {server.hosts.length === 0 ? (
                <Text size="sm">None</Text>
              ) : (
                <Group gap={4}>
                  {server.hosts.map((host) => (
                    <Badge key={host} variant="light" color="gray" tt="none">
                      {visibleText(host)}
                    </Badge>
                  ))}
                </Group>
              )}
            </Fact>
          ) : null}
          {server.variables.length === 0 ? null : (
            <Fact label="Reads from your environment">
              <Group gap={4}>
                {server.variables.map((name) => (
                  <Group key={name} gap={2} wrap="nowrap">
                    <Badge variant="light" color="gray" tt="none">
                      {visibleText(name)}
                    </Badge>
                    {server.sensitive.includes(name) ? (
                      <Badge variant="light" color="yellow">
                        credential
                      </Badge>
                    ) : null}
                  </Group>
                ))}
              </Group>
            </Fact>
          )}
        </Stack>
        {stdio && server.hosts.length === 0 && downloadsAtStart(server) ? (
          <Text size="xs" c="dimmed">
            It can't download packages at start; list hosts in .10db/mcp-hosts.json if it needs to.
          </Text>
        ) : null}
        <Stack gap={4} align="flex-start">
          <Button
            variant="subtle"
            size="compact-xs"
            aria-expanded={full}
            onClick={() => {
              setFull(!full);
            }}
          >
            Full Details
          </Button>
          <Collapse expanded={full}>
            <Text size="xs" component="div" style={{ whiteSpace: 'pre-wrap' }}>
              {server.body}
            </Text>
          </Collapse>
        </Stack>
        <Text size="xs" c="dimmed">
          Approves this exact config. Any change asks again.
        </Text>
        <Group justify="flex-end" gap="sm">
          {error === null ? null : (
            <Text size="xs" c="red" style={{ flex: 1 }}>
              {error}
            </Text>
          )}
          <Button variant="default" data-autofocus onClick={onCancel}>
            Cancel
          </Button>
          <Button loading={loading} onClick={onConfirm}>
            Turn On
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
