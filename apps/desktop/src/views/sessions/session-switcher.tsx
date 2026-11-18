import type { ProjectId, ProjectViewDto } from '@10db/contracts';
import { ActionIcon, Menu, Text } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import type { ClosedChat } from './closed-tabs';
import type { PanelGroup, PanelRow } from './panel-order';

/**
 * The ⌄ beside the title: every open session by project, then Recently closed and New Session. It is the
 * panel's list for a window too narrow to keep the panel open.
 */
export function SessionSwitcher({
  groups,
  projects,
  closed,
  selectedKey,
  onSelect,
  onReopen,
  onNew,
}: {
  readonly groups: readonly PanelGroup[];
  readonly projects: readonly ProjectViewDto[];
  readonly closed: readonly ClosedChat[];
  readonly selectedKey: string | null;
  readonly onSelect: (row: PanelRow) => void;
  readonly onReopen: (entry: ClosedChat) => void;
  readonly onNew: () => void;
}) {
  const nameOf = (id: ProjectId): string => projects.find((p) => p.id === id)?.name ?? '';
  return (
    <Menu position="bottom-start" withinPortal width={280}>
      <Menu.Target>
        <ActionIcon variant="subtle" size="sm" aria-label="Switch session">
          <IconChevronDown size={14} stroke={1.5} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {groups.map((group) => (
          <div key={group.projectId}>
            <Menu.Label>{nameOf(group.projectId)}</Menu.Label>
            {group.rows.map((row) => (
              <Menu.Item
                key={row.key}
                aria-current={row.key === selectedKey ? 'true' : undefined}
                fw={row.key === selectedKey ? 600 : 400}
                onClick={() => {
                  onSelect(row);
                }}
              >
                {row.kind === 'chat' ? row.chat.title : 'New session'}
              </Menu.Item>
            ))}
          </div>
        ))}
        {closed.length === 0 ? null : (
          <>
            <Menu.Divider />
            <Menu.Label>Recently closed</Menu.Label>
            {closed.map((entry) => (
              <Menu.Item
                key={entry.chatId}
                onClick={() => {
                  onReopen(entry);
                }}
              >
                {entry.title}
              </Menu.Item>
            ))}
          </>
        )}
        <Menu.Divider />
        <Menu.Item
          rightSection={
            <Text size="xs" c="dimmed">
              ⌘T
            </Text>
          }
          onClick={onNew}
        >
          New Session
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
