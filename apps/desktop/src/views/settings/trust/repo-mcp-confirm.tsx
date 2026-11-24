import { McpTransport, type RepoMcpServerDto } from '@10db/contracts';
import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Collapse,
  Divider,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { Fragment, useState, type ReactNode } from 'react';
import { visibleText } from './visible-text';

/** Commands that fetch a package when they start. */
const DOWNLOADERS = ['npx', 'bunx', 'uvx'];

function downloadsAtStart(server: RepoMcpServerDto): boolean {
  const command = (server.command ?? '').split('/').at(-1) ?? '';
  return DOWNLOADERS.includes(command) || (command === 'pnpm' && server.args[0] === 'dlx');
}

const assignment = (entry: { readonly name: string; readonly value: string }): string =>
  `${visibleText(entry.name)}=${visibleText(entry.value)}`;

/** The AWS profile the env block names, when it is a concrete one: 10db exports credentials for it. */
function awsProfile(server: RepoMcpServerDto): string | null {
  const profile = server.env.find((e) => e.name === 'AWS_PROFILE')?.value;
  return profile === undefined || profile === '' || profile.includes('${') ? null : profile;
}

/** A value the builder is approving wraps wherever it must; nothing is cut off. */
const WRAP = { overflowWrap: 'anywhere', wordBreak: 'break-all', whiteSpace: 'pre-wrap' } as const;

/** A badge that wraps its text instead of clipping it. */
function Chip({ color, children }: { readonly color: string; readonly children: ReactNode }) {
  return (
    <Badge
      variant="light"
      color={color}
      tt="none"
      h="auto"
      maw="100%"
      py={2}
      styles={{ label: { ...WRAP, textOverflow: 'clip', overflow: 'visible' } }}
    >
      {children}
    </Badge>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Group gap="md" align="flex-start" wrap="nowrap" px="md" py="xs">
      <Text size="sm" c="dimmed" w={96} style={{ flex: 'none' }}>
        {label}
      </Text>
      <Box style={{ minWidth: 0, flex: 1 }}>{children}</Box>
    </Group>
  );
}

/**
 * What turning a repo server On approves, from its review: what it runs or connects to, which hosts it
 * reaches, what it sets and reads. All of it is in one panel; the approval card's own text is its last row,
 * folded. Repo text is shown with unsafe characters made visible.
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
  const replaced = server.env.map((e) => e.name).filter((n) => n === 'PATH' || n === 'HOME');
  const aws = awsProfile(server);
  const earlier = server.earlierHosts;
  const added = earlier === null ? [] : server.hosts.filter((host) => !earlier.includes(host));
  const dropped = earlier === null ? [] : earlier.filter((host) => !server.hosts.includes(host));
  const runs = [server.command ?? '', ...server.args].map(visibleText).join(' ');
  const rows: ReactNode[] = [
    stdio ? (
      <Fact key="runs" label="Runs">
        <Code style={WRAP}>{runs}</Code>
        {server.hosts.length === 0 && downloadsAtStart(server) ? (
          <Text size="xs" c="dimmed" mt={4}>
            It can't download packages at start; list hosts in .10db/mcp-hosts.json if it needs to.
          </Text>
        ) : null}
      </Fact>
    ) : (
      <Fact key="connects" label="Connects to">
        <Code style={WRAP}>{visibleText(server.url ?? '')}</Code>
      </Fact>
    ),
  ];
  if (stdio)
    rows.push(
      <Fact key="network" label="Network">
        {server.hosts.length === 0 ? (
          <Text size="sm">None</Text>
        ) : (
          <Group gap={4}>
            {server.hosts.map((host) => (
              <Chip key={host} color="gray">
                {visibleText(host)}
              </Chip>
            ))}
          </Group>
        )}
      </Fact>,
    );
  if (added.length > 0)
    rows.push(
      <Fact key="added" label="New hosts">
        <Text size="sm">{`${added.map(visibleText).join(', ')} (since your last approval)`}</Text>
      </Fact>,
    );
  if (dropped.length > 0)
    rows.push(
      <Fact key="dropped" label="Dropped">
        <Text size="sm">{`${dropped.map(visibleText).join(', ')} (no longer reached)`}</Text>
      </Fact>,
    );
  if (server.env.length > 0)
    rows.push(
      <Fact key="sets" label="Sets">
        <Code block style={WRAP}>
          {server.env.map(assignment).join('\n')}
        </Code>
      </Fact>,
    );
  if (replaced.length > 0)
    rows.push(
      <Box key="replaced" px="md" py="xs">
        <Alert color="yellow" p="xs">
          {`Its env block replaces ${replaced.join(' and ')}, so what it runs is looked up as shown.`}
        </Alert>
      </Box>,
    );
  if (aws !== null)
    rows.push(
      <Fact key="aws" label="AWS">
        <Group gap={4}>
          <Text size="sm">{`short-lived credentials for profile ${visibleText(aws)}`}</Text>
          <Chip color="yellow">credential</Chip>
        </Group>
      </Fact>,
    );
  if (server.headers.length > 0)
    rows.push(
      <Fact key="headers" label="Headers">
        <Code block style={WRAP}>
          {server.headers.map(assignment).join('\n')}
        </Code>
      </Fact>,
    );
  if (server.variables.length > 0)
    rows.push(
      <Fact key="reads" label="Reads">
        <Group gap={4}>
          {server.variables.map((name) => (
            <Group key={name} gap={2}>
              <Chip color="gray">{visibleText(name)}</Chip>
              {server.sensitive.includes(name) ? <Chip color="yellow">credential</Chip> : null}
            </Group>
          ))}
        </Group>
      </Fact>,
    );
  return (
    <Modal
      opened
      onClose={onCancel}
      title={`Turn On ${visibleText(server.name)}?`}
      centered
      size="lg"
    >
      <Stack gap="md">
        <Text size="sm">From this repo's .mcp.json. Sessions in this project get its tools.</Text>
        <Paper withBorder radius="md">
          {rows.map((row, i) => (
            <Fragment key={i}>
              {i > 0 ? <Divider /> : null}
              {row}
            </Fragment>
          ))}
          <Divider />
          <UnstyledButton
            w="100%"
            px="md"
            py="xs"
            aria-expanded={full}
            onClick={() => {
              setFull(!full);
            }}
          >
            <Group gap="xs" wrap="nowrap">
              <IconChevronRight
                size={14}
                style={{
                  transform: full ? 'rotate(90deg)' : 'none',
                  transition: 'transform 150ms',
                }}
              />
              <Text size="sm" c="dimmed">
                Full details
              </Text>
            </Group>
          </UnstyledButton>
          <Collapse expanded={full}>
            <Text size="xs" component="div" px="md" pb="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {server.body}
            </Text>
          </Collapse>
        </Paper>
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Text size="xs" c={error === null ? 'dimmed' : 'red'}>
            {error ?? 'Approves this exact config. Any change asks again.'}
          </Text>
          <Group gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
            <Button variant="default" data-autofocus onClick={onCancel}>
              Cancel
            </Button>
            <Button loading={loading} onClick={onConfirm}>
              Turn On
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
