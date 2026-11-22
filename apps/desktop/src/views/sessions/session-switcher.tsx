import type { ProjectId, ProjectViewDto } from '@10db/contracts';
import { ActionIcon, Menu, Text, UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';
import classes from './session-switcher.module.css';
import { IconChevronDown } from '@tabler/icons-react';
import type { ClosedChat } from './closed-tabs';
import type { PanelGroup, PanelRow } from './panel-order';

/**
 * The ⌄ beside the title: every open session by project (not the fresh tabs), then Recently closed and New
 * Session. It is the panel's list for a window too narrow to keep the panel open.
 */
export function SessionSwitcher({
  groups,
  projects,
  closed,
  selectedKey,
  onSelect,
  onReopen,
  onNew,
  label,
}: {
  readonly groups: readonly PanelGroup[];
  readonly projects: readonly ProjectViewDto[];
  readonly closed: readonly ClosedChat[];
  readonly selectedKey: string | null;
  readonly onSelect: (row: PanelRow) => void;
  readonly onReopen: (entry: ClosedChat) => void;
  readonly onNew: () => void;
  /** The session's title: given, the title and its chevron are one button that opens the menu. */
  readonly label?: ReactNode;
}) {
  const nameOf = (id: ProjectId): string => projects.find((p) => p.id === id)?.name ?? '';
  return (
    <Menu position="bottom-start" withinPortal width={280}>
      <Menu.Target>
        {label === undefined ? (
          <ActionIcon variant="subtle" size="sm" aria-label="Switch session">
            <IconChevronDown size={14} stroke={1.5} />
          </ActionIcon>
        ) : (
          <UnstyledButton className={classes['title']} aria-label="Switch session">
            <span className={classes['label']}>{label}</span>
            <IconChevronDown size={14} stroke={1.75} className={classes['chevron']} aria-hidden />
          </UnstyledButton>
        )}
      </Menu.Target>
      <Menu.Dropdown>
        {/* A fresh tab is New Session, the menu's last item, so the lists show only sessions. */}
        {groups
          .map((group) => ({ ...group, rows: group.rows.filter((row) => row.kind === 'chat') }))
          .filter((group) => group.rows.length > 0)
          .map((group) => (
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
                  {row.chat.title}
                </Menu.Item>
              ))}
            </div>
          ))}
        {closed.length === 0 ? null : (
          <>
            <Menu.Divider />
            <Menu.Label>Recently Closed</Menu.Label>
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
