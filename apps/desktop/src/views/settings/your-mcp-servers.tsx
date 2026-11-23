import {
  McpSignInState,
  YourMcpServerState,
  YourMcpSource,
  type McpSignInOwnClaudeDto,
  type McpSignInRowDto,
  type McpSignInTerminalDto,
  type YourMcpServerDto,
} from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Collapse,
  CopyButton,
  Group,
  Modal,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useState } from 'react';
import {
  useApproveYourMcpServer,
  useMcpSignIns,
  useSetTrust,
  useStartMcpSignIn,
  useTrust,
} from '../../daemon/trust-queries';
import { SettingRow, SettingsCard } from './setting-row';

const SOURCE_LABELS: Readonly<Record<YourMcpSource, string>> = {
  [YourMcpSource.ClaudeJson]: '~/.claude.json',
  [YourMcpSource.CodexConfig]: '~/.codex/config.toml',
  [YourMcpSource.Plugin]: 'a plugin',
};

/** What the server does when a session starts it: the command and arguments, or the url. */
function runs(server: YourMcpServerDto): string {
  if (server.url !== null) return `Connects to ${server.url}`;
  return `Runs ${[server.command ?? '', ...server.args].join(' ').trim()}`;
}

/** The `oauth` keys Claude Code reads that Codex has no key for. */
const CODEX_UNUSED_OAUTH = ['authServerMetadataUrl', 'xaa'];

const COULDNT_READ = "Couldn't read whether it's signed in.";

/** One account's sign-in to one server: what it says and the button that moves it on. */
function SignInLine({ row }: { readonly row: McpSignInRowDto }) {
  const start = useStartMcpSignIn();
  const words = `${row.accountLabel} to ${row.name}`;
  const begin = (label: string, text: string) => (
    <Button
      size="compact-xs"
      variant="default"
      aria-label={`${label} ${words}`}
      loading={start.isPending}
      onClick={() => {
        start.mutate({ accountId: row.accountId, key: row.key });
      }}
    >
      {text}
    </Button>
  );
  return (
    <Group gap="xs" wrap="nowrap" align="center">
      <Text
        size="xs"
        c={row.state === McpSignInState.Failed ? 'red' : 'dimmed'}
        style={{ wordBreak: 'break-word' }}
      >
        {row.accountLabel}:{' '}
        {row.state === McpSignInState.SignedIn
          ? 'Signed in'
          : row.state === McpSignInState.NotSignedIn
            ? 'Not signed in'
            : row.state === McpSignInState.SigningIn
              ? 'Signing in in your browser…'
              : (row.message ?? COULDNT_READ)}
      </Text>
      {row.state === McpSignInState.SignedIn
        ? null
        : row.state === McpSignInState.SigningIn
          ? begin('Open page again for', 'Open page again')
          : begin('Sign in', 'Sign in')}
      {start.isError ? (
        <Text size="xs" c="red">
          {start.error.message}
        </Text>
      ) : null}
    </Group>
  );
}

/** What to run in a terminal to sign a Claude plan account in to a server; there is no sign-in 10db can start for it. */
function TerminalEntry({ entry }: { readonly entry: McpSignInTerminalDto }) {
  return (
    <Stack gap={4} px="md" py="sm">
      <Text size="sm">
        To sign {entry.accountLabel} in to a server that signs in with OAuth, run:
      </Text>
      <Group gap="xs" wrap="nowrap" align="center">
        <Code block style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {entry.command}
        </Code>
        <CopyButton value={entry.command}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? 'Copied' : 'Copy command'} withArrow>
              <ActionIcon
                size="md"
                variant="subtle"
                color={copied ? 'green' : 'gray'}
                aria-label={copied ? 'Copied' : 'Copy command'}
                onClick={copy}
              >
                {copied ? (
                  <IconCheck size={20} stroke={1.5} />
                ) : (
                  <IconCopy size={20} stroke={1.5} />
                )}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
      <Text size="sm">Then run /mcp and sign in.</Text>
    </Stack>
  );
}

/** What a server sets, sends and filters: the facts behind its one-line summary. */
function ServerDetails({ server }: { readonly server: YourMcpServerDto }) {
  const codexUnused = server.oauth
    .map((entry) => entry.name)
    .filter((name) => CODEX_UNUSED_OAUTH.includes(name));
  return (
    <Stack gap={2}>
      {server.envNames.length === 0 ? null : (
        <Text size="xs" c="dimmed">
          Sets {server.envNames.join(', ')}
        </Text>
      )}
      {server.shownEnv.map((entry) => (
        <Text key={entry.name} size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
          {entry.name}={entry.value}
        </Text>
      ))}
      {server.oauth.length === 0 ? null : (
        <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
          Signs in with OAuth:{' '}
          {server.oauth.map((entry) => `${entry.name}=${entry.value}`).join(', ')}
        </Text>
      )}
      {codexUnused.length === 0 ? null : (
        <Text size="xs" c="dimmed">
          Codex sessions don't use: {codexUnused.join(', ')}
        </Text>
      )}
      {server.headerNames.length === 0 ? null : (
        <Text size="xs" c="dimmed">
          Sends headers {server.headerNames.join(', ')}
        </Text>
      )}
      {server.cwd === null ? null : (
        <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
          Starts in {server.cwd}
        </Text>
      )}
      {server.enabledTools === null ? null : (
        <Text size="xs" c="dimmed">
          Only tools: {server.enabledTools.join(', ')}
        </Text>
      )}
      {server.disabledTools.length === 0 ? null : (
        <Text size="xs" c="dimmed">
          Without tools: {server.disabledTools.join(', ')}
        </Text>
      )}
      {server.codexOnly.length === 0 ? null : (
        <Text size="xs" c="dimmed">
          Codex only: {server.codexOnly.join(', ')}
        </Text>
      )}
    </Stack>
  );
}

/** Whether a server has anything to show beyond its summary. */
function hasDetails(server: YourMcpServerDto): boolean {
  return (
    server.envNames.length > 0 ||
    server.oauth.length > 0 ||
    server.headerNames.length > 0 ||
    server.cwd !== null ||
    server.enabledTools !== null ||
    server.disabledTools.length > 0 ||
    server.codexOnly.length > 0
  );
}

/** A server's summary: where it comes from and what it runs, its sign-ins, and a Details fold. */
function ServerText({
  server,
  signIns,
  ownClaudeCode,
}: {
  readonly server: YourMcpServerDto;
  readonly signIns: readonly McpSignInRowDto[];
  /** The default-folder Claude plan accounts, when the server is one a sign-in matters for. */
  readonly ownClaudeCode: readonly McpSignInOwnClaudeDto[];
}) {
  const [open, setOpen] = useState(false);
  const sourceLabel =
    server.source === YourMcpSource.Plugin && server.pluginId !== null
      ? `Comes with ${server.pluginId}`
      : SOURCE_LABELS[server.source];
  return (
    <Stack gap={2}>
      <Text size="sm" c="dimmed">
        {sourceLabel}
      </Text>
      {server.transport === null ? null : (
        <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
          {runs(server)}
        </Text>
      )}
      {signIns.map((row) => (
        <SignInLine key={row.accountId} row={row} />
      ))}
      {ownClaudeCode.map((account) => (
        // 10db holds no sign-in state for these: Claude Code keeps it in its own store.
        <Text key={account.accountId} size="xs" c="dimmed">
          {account.accountLabel}: Signs in through your own Claude Code (<Code>/mcp</Code>)
        </Text>
      ))}
      {server.reason === null ? null : (
        <Text size="xs" c="red">
          {server.reason}
        </Text>
      )}
      {hasDetails(server) ? (
        <>
          <Anchor
            component="button"
            type="button"
            size="xs"
            aria-expanded={open}
            onClick={() => {
              setOpen((was) => !was);
            }}
            style={{ alignSelf: 'flex-start' }}
          >
            {open ? 'Hide Details' : 'Details'}
          </Anchor>
          <Collapse expanded={open}>
            <ServerDetails server={server} />
          </Collapse>
        </>
      ) : null}
    </Stack>
  );
}

function StateBadge({ state }: { readonly state: YourMcpServerState }) {
  if (state === YourMcpServerState.New) return <Badge variant="light">New</Badge>;
  if (state === YourMcpServerState.Changed) return <Badge color="orange">Changed</Badge>;
  return null;
}

/** Confirms what Approve lets the server do, then sends its key and the hash the page showed. */
function ApproveModal({
  server,
  onClose,
}: {
  readonly server: YourMcpServerDto;
  readonly onClose: () => void;
}) {
  const approve = useApproveYourMcpServer();
  return (
    <Modal opened onClose={onClose} title={`Approve ${server.name}`}>
      <Stack gap="sm">
        <Text size="sm">
          {server.name} runs outside 10db's sandbox, as Claude Code runs it, with your login
          environment, from your home folder. Its tools can read and change anything you can, and
          every call to them is judged.
        </Text>
        {server.sendsNoHeaders ? (
          <Text size="sm">
            It sends no headers. If it signs in with OAuth, sign it in as each agent does: in Claude
            Code, or below for a Codex account.
          </Text>
        ) : null}
        {approve.isError ? <Alert color="red">{approve.error.message}</Alert> : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={approve.isPending}
            disabled={server.configHash === null}
            onClick={() => {
              if (server.configHash === null) return;
              approve.mutate(
                { key: server.key, configHash: server.configHash },
                { onSuccess: onClose },
              );
            }}
          >
            Approve
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The builder's own MCP servers: each with Approve until it is approved, then a switch. */
export function YourMcpServers() {
  const trust = useTrust();
  const signIns = useMcpSignIns();
  const set = useSetTrust();
  const [asking, setAsking] = useState<YourMcpServerDto | null>(null);
  const data = trust.data;
  if (data === undefined) return null;
  const master = data.switches.yourMcpServers;
  return (
    <SettingsCard
      title="Your MCP Servers"
      description="Approve each server once, then switch it on or off."
    >
      {data.mcpNotice === null ? null : (
        <Text size="sm" c="dimmed" px="md" py="sm">
          {data.mcpNotice}
        </Text>
      )}
      {data.mcpServers.length === 0 ? (
        <Text size="sm" c="dimmed" px="md" py="sm">
          No MCP servers in your ~/.claude.json, ~/.codex/config.toml or plugins.
        </Text>
      ) : null}
      {data.mcpServers.map((server) => {
        const canApprove =
          server.state === YourMcpServerState.New || server.state === YourMcpServerState.Changed;
        return (
          <SettingRow
            key={server.key}
            label={server.name}
            description={
              <ServerText
                server={server}
                signIns={(signIns.data?.rows ?? []).filter((row) => row.key === server.key)}
                ownClaudeCode={
                  signIns.data?.candidates.includes(server.key) === true
                    ? signIns.data.ownClaudeCode
                    : []
                }
              />
            }
          >
            <Group justify="flex-end" gap="xs" wrap="nowrap">
              <StateBadge state={server.state} />
              {canApprove ? (
                <Button
                  size="compact-sm"
                  aria-label={`Approve ${server.name}`}
                  onClick={() => {
                    setAsking(server);
                  }}
                >
                  Approve
                </Button>
              ) : null}
              {server.state === YourMcpServerState.Approved ? (
                <Switch
                  aria-label={server.name}
                  checked={server.on}
                  disabled={!master}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    set.mutate((saved) => ({
                      ...saved,
                      mcpServers: { ...saved.mcpServers, [server.key]: on },
                    }));
                  }}
                />
              ) : null}
            </Group>
          </SettingRow>
        );
      })}
      {(signIns.data?.terminal ?? []).map((entry) => (
        <TerminalEntry key={entry.accountId} entry={entry} />
      ))}
      {asking === null ? null : (
        <ApproveModal
          server={asking}
          onClose={() => {
            setAsking(null);
          }}
        />
      )}
    </SettingsCard>
  );
}
