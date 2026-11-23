import {
  YourMcpServerState,
  type McpSignInTerminalDto,
  type YourMcpServerDto,
} from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
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
  useTrust,
} from '../../daemon/trust-queries';
import { McpServerRow } from './mcp-server-row';
import { SettingsCard } from './setting-row';

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
          <McpServerRow
            key={server.key}
            server={server}
            signIns={(signIns.data?.rows ?? []).filter((row) => row.key === server.key)}
            ownClaudeCode={
              signIns.data?.candidates.includes(server.key) === true
                ? signIns.data.ownClaudeCode
                : []
            }
            control={
              <>
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
              </>
            }
          />
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
