import { McpVerdict, type ProjectId, type RepoMcpServerDto } from '@10db/contracts';
import { Alert, Badge, Group, Switch, Text } from '@mantine/core';
import { useState } from 'react';
import { useRepoMcpServers, useSetRepoMcpVerdict } from '../../../daemon/trust-queries';
import { ConfirmModal } from '../../../shell/confirm-modal';
import { SettingRow, SettingsCard } from '../setting-row';

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
        <ConfirmModal
          opened
          title={`Run ${asking.name} in This Project?`}
          confirmLabel="Turn On"
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
        >
          <Text component="span" display="block" style={{ whiteSpace: 'pre-wrap' }}>
            {asking.body}
          </Text>
        </ConfirmModal>
      )}
    </SettingsCard>
  );
}
