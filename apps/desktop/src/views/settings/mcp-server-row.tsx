import {
  McpSignInState,
  YourMcpSource,
  type McpSignInOwnClaudeDto,
  type McpSignInRowDto,
  type YourMcpServerDto,
} from '@10db/contracts';
import {
  Badge,
  Box,
  Button,
  Code,
  Collapse,
  Group,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { useStartMcpSignIn } from '../../daemon/trust-queries';

const SOURCE_LABELS: Readonly<Record<YourMcpSource, string>> = {
  [YourMcpSource.ClaudeJson]: '~/.claude.json',
  [YourMcpSource.CodexConfig]: '~/.codex/config.toml',
  [YourMcpSource.Plugin]: 'a plugin',
};

/** The `oauth` keys Claude Code reads that Codex has no key for. */
const CODEX_UNUSED_OAUTH = ['authServerMetadataUrl', 'xaa'];

const COULDNT_READ = "Couldn't read whether it's signed in.";

/** What the server does when a session starts it: the command and arguments, or the url. */
function runs(server: YourMcpServerDto): string {
  if (server.url !== null) return `Connects to ${server.url}`;
  return `Runs ${[server.command ?? '', ...server.args].join(' ').trim()}`;
}

function signInWords(row: McpSignInRowDto): string {
  switch (row.state) {
    case McpSignInState.SignedIn:
      return 'Signed in';
    case McpSignInState.NotSignedIn:
      return 'Not signed in';
    case McpSignInState.SigningIn:
      return 'Signing in in your browser…';
    case McpSignInState.Failed:
    case McpSignInState.Unknown:
      return row.message ?? COULDNT_READ;
  }
}

/** The button that moves one account's sign-in on, or nothing once it is signed in. */
function SignInButton({ row, server }: { readonly row: McpSignInRowDto; readonly server: string }) {
  const start = useStartMcpSignIn();
  if (row.state === McpSignInState.SignedIn) return null;
  const again = row.state === McpSignInState.SigningIn;
  return (
    <Stack gap={2} align="flex-end">
      <Button
        size="compact-xs"
        variant="default"
        aria-label={`${again ? 'Open page again for' : 'Sign in'} ${row.accountLabel} to ${server}`}
        loading={start.isPending}
        onClick={() => {
          start.mutate({ accountId: row.accountId, key: row.key });
        }}
      >
        {again ? 'Open Page Again' : 'Sign In'}
      </Button>
      {start.isError ? (
        <Text size="xs" c="red">
          {start.error.message}
        </Text>
      ) : null}
    </Stack>
  );
}

/** Each account's sign-in to the server: the account, its state, and the button that moves it on. */
function SignIns({
  server,
  signIns,
  ownClaudeCode,
}: {
  readonly server: YourMcpServerDto;
  readonly signIns: readonly McpSignInRowDto[];
  readonly ownClaudeCode: readonly McpSignInOwnClaudeDto[];
}) {
  if (signIns.length === 0 && ownClaudeCode.length === 0) return null;
  return (
    <Table verticalSpacing={4} horizontalSpacing="xs" withRowBorders={false} fz="xs">
      <Table.Tbody>
        {signIns.map((row) => (
          <Table.Tr key={row.accountId}>
            <Table.Td w={180} style={{ whiteSpace: 'nowrap' }}>
              {row.accountLabel}
            </Table.Td>
            <Table.Td c={row.state === McpSignInState.Failed ? 'red' : 'dimmed'}>
              {signInWords(row)}
            </Table.Td>
            <Table.Td ta="right" style={{ whiteSpace: 'nowrap' }}>
              <SignInButton row={row} server={server.name} />
            </Table.Td>
          </Table.Tr>
        ))}
        {ownClaudeCode.map((account) => (
          // 10db holds no sign-in state for these: Claude Code keeps it in its own store.
          <Table.Tr key={account.accountId}>
            <Table.Td w={180} style={{ whiteSpace: 'nowrap' }}>
              {account.accountLabel}
            </Table.Td>
            <Table.Td c="dimmed">
              Signs in through your own Claude Code (<Code fz="xs">/mcp</Code>)
            </Table.Td>
            <Table.Td />
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** What a server sets, sends and filters, one dimmed line each. */
function ServerFacts({ server }: { readonly server: YourMcpServerDto }) {
  const codexUnused = server.oauth
    .map((entry) => entry.name)
    .filter((name) => CODEX_UNUSED_OAUTH.includes(name));
  const lines: ReactNode[] = [
    server.transport === null ? null : runs(server),
    server.envNames.length === 0 ? null : `Sets ${server.envNames.join(', ')}`,
    ...server.shownEnv.map((entry) => `${entry.name}=${entry.value}`),
    server.oauth.length === 0
      ? null
      : `Signs in with OAuth: ${server.oauth.map((e) => `${e.name}=${e.value}`).join(', ')}`,
    codexUnused.length === 0 ? null : `Codex sessions don't use: ${codexUnused.join(', ')}`,
    server.headerNames.length === 0 ? null : `Sends headers ${server.headerNames.join(', ')}`,
    server.cwd === null ? null : `Starts in ${server.cwd}`,
    server.enabledTools === null ? null : `Only tools: ${server.enabledTools.join(', ')}`,
    server.disabledTools.length === 0 ? null : `Without tools: ${server.disabledTools.join(', ')}`,
    server.codexOnly.length === 0 ? null : `Codex only: ${server.codexOnly.join(', ')}`,
  ].filter((line) => line !== null);
  if (lines.length === 0) return null;
  return (
    <Stack gap={2}>
      {lines.map((line, i) => (
        <Text key={i} size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>
          {line}
        </Text>
      ))}
    </Stack>
  );
}

/** The sign-ins that want the builder: any account not signed in. */
function signInBadge(signIns: readonly McpSignInRowDto[]): ReactNode {
  const waiting = signIns.filter((row) => row.state !== McpSignInState.SignedIn);
  if (waiting.length === 0) return null;
  const failed = waiting.some((row) => row.state === McpSignInState.Failed);
  return (
    <Badge
      variant="light"
      color={failed ? 'red' : 'yellow'}
      style={{ minWidth: 'max-content' }}
      styles={{ label: { overflow: 'visible', textOverflow: 'clip' } }}
    >
      {waiting.length === 1 ? 'Needs Sign-in' : `${String(waiting.length)} Need Sign-in`}
    </Badge>
  );
}

/**
 * One of the builder's MCP servers: its name and source on one line with its sign-in badge and control on the
 * right; the name opens what it runs, each account's sign-in and the rest of its config.
 */
export function McpServerRow({
  server,
  signIns,
  ownClaudeCode,
  control,
}: {
  readonly server: YourMcpServerDto;
  readonly signIns: readonly McpSignInRowDto[];
  /** The default-folder Claude plan accounts, when the server is one a sign-in matters for. */
  readonly ownClaudeCode: readonly McpSignInOwnClaudeDto[];
  /** The state badge and Approve or the switch. */
  readonly control: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const source =
    server.source === YourMcpSource.Plugin && server.pluginId !== null
      ? `Comes with ${server.pluginId}`
      : SOURCE_LABELS[server.source];
  const Chevron = open ? IconChevronDown : IconChevronRight;
  return (
    <Box px="md" py="sm">
      <Group justify="space-between" wrap="nowrap" gap="md">
        <UnstyledButton
          aria-expanded={open}
          aria-label={`Details for ${server.name}`}
          onClick={() => {
            setOpen((was) => !was);
          }}
          style={{ flex: 1, minWidth: 0 }}
        >
          <Group gap="xs" wrap="nowrap">
            <Chevron size={14} aria-hidden style={{ flex: 'none' }} />
            <Text size="sm" fw={500} truncate>
              {server.name}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {source}
            </Text>
          </Group>
        </UnstyledButton>
        <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
          {signInBadge(signIns)}
          {control}
        </Group>
      </Group>
      {server.reason === null ? null : (
        <Text size="xs" c="red" pl={22}>
          {server.reason}
        </Text>
      )}
      <Collapse expanded={open}>
        <Stack gap="xs" pl={22} pt="xs">
          <ServerFacts server={server} />
          <SignIns server={server} signIns={signIns} ownClaudeCode={ownClaudeCode} />
        </Stack>
      </Collapse>
    </Box>
  );
}
