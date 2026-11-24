import { McpVerdict, type ProjectId, type RepoMcpServerDto } from '@10db/contracts';
import { Alert, Badge, Button, Group, Switch, Text } from '@mantine/core';
import { useState } from 'react';
import { useRepoMcpServers, useSetRepoMcpVerdict } from '../../../daemon/trust-queries';
import { SettingRow, SettingsCard } from '../setting-row';
import { RepoMcpConfirm } from './repo-mcp-confirm';

const STATE_COLORS = { On: 'green', Off: 'gray', Waiting: 'yellow' } as const;

/** Where a repo server stands: approved is On, denied is Off, and one nobody answered yet is Waiting. */
function stateOf(server: RepoMcpServerDto): keyof typeof STATE_COLORS {
  if (server.verdict === McpVerdict.Approved) return 'On';
  return server.verdict === McpVerdict.Denied ? 'Off' : 'Waiting';
}

/**
 * The checkout's `.mcp.json` servers. Turning one On shows the approval card's own text for the current
 * config and asks first; Off is written at once. A choice answers the server's open Inbox card.
 */
export function RepoMcpServers({ projectId }: { readonly projectId: ProjectId }) {
  const servers = useRepoMcpServers(projectId);
  const set = useSetRepoMcpVerdict(projectId);
  const [asking, setAsking] = useState<RepoMcpServerDto | null>(null);
  const list = servers.data?.servers ?? [];
  if (servers.isError) return <Alert color="red">{servers.error.message}</Alert>;
  const error = servers.data?.error ?? null;
  if (error === null && list.length === 0) return null;
  return (
    <SettingsCard
      title="Repo MCP Servers"
      description="From this project's .mcp.json. A server runs in this project's sessions only once you turn it On."
    >
      {error === null ? null : (
        <SettingRow label=".mcp.json can't be read" description={error}>
          <></>
        </SettingRow>
      )}
      {list.map((server) => {
        const state = stateOf(server);
        return (
          <SettingRow
            key={`${server.name} ${server.configHash}`}
            label={server.name}
            description={server.transport}
          >
            <Group justify="flex-end" gap="sm" wrap="nowrap">
              <Badge variant="light" color={STATE_COLORS[state]}>
                {state}
              </Badge>
              {state === 'Waiting' ? (
                <Button
                  variant="subtle"
                  size="compact-xs"
                  color="gray"
                  aria-label={`Deny ${server.name}`}
                  disabled={set.isPending}
                  onClick={() => {
                    set.mutate({
                      name: server.name,
                      configHash: server.configHash,
                      verdict: McpVerdict.Denied,
                    });
                  }}
                >
                  Deny
                </Button>
              ) : null}
              <Switch
                aria-label={server.name}
                checked={state === 'On'}
                disabled={set.isPending}
                onChange={(e) => {
                  if (e.currentTarget.checked) setAsking(server);
                  else
                    set.mutate({
                      name: server.name,
                      configHash: server.configHash,
                      verdict: McpVerdict.Denied,
                    });
                }}
              />
            </Group>
          </SettingRow>
        );
      })}
      {set.isError && asking === null ? (
        <Text size="xs" c="red" px="md" py="xs">
          {set.error.message}
        </Text>
      ) : null}
      {asking === null ? null : (
        <RepoMcpConfirm
          server={asking}
          loading={set.isPending}
          error={set.isError ? set.error.message : null}
          onConfirm={() => {
            set.mutate(
              {
                name: asking.name,
                configHash: asking.configHash,
                verdict: McpVerdict.Approved,
              },
              {
                onSuccess: () => {
                  setAsking(null);
                },
              },
            );
          }}
          onCancel={() => {
            set.reset();
            setAsking(null);
          }}
        />
      )}
    </SettingsCard>
  );
}
