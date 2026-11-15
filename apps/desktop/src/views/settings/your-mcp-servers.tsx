import { YourMcpServerState, YourMcpSource, type YourMcpServerDto } from '@10db/contracts';
import { Alert, Badge, Button, Group, Modal, Stack, Switch, Text } from '@mantine/core';
import { useState } from 'react';
import { useApproveYourMcpServer, useSetTrust, useTrust } from '../../daemon/trust-queries';
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

/** A server's details: where it comes from, what it runs, what it sets and sends. */
function ServerText({ server }: { readonly server: YourMcpServerDto }) {
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
      {server.reason === null ? null : (
        <Text size="xs" c="red">
          {server.reason}
        </Text>
      )}
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
            It sends no headers. If it signs in with OAuth, it won't connect in 10db yet.
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
  const set = useSetTrust();
  const [asking, setAsking] = useState<YourMcpServerDto | null>(null);
  const data = trust.data;
  if (data === undefined) return null;
  const master = data.switches.yourMcpServers;
  return (
    <SettingsCard title="Your MCP servers">
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
            description={<ServerText server={server} />}
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
