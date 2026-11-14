import type { ChatDto, ProjectViewDto } from '@10db/contracts';
import { ActionIcon, Group, UnstyledButton, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { CHAT_DEFAULT_TITLE } from '@10db/contracts';
import { ProjectTile } from '../../shell/project-tile';
import type { FreshTab } from './fresh-tabs';

/** One tab of the strip: a chat, or a fresh tab not yet made into one. */
export type StripTab =
  | {
      readonly kind: 'chat';
      readonly key: string;
      readonly chat: ChatDto;
      readonly position: number;
    }
  | {
      readonly kind: 'fresh';
      readonly key: string;
      readonly tab: FreshTab;
      readonly position: number;
    };

export interface TabStripProps {
  readonly tabs: readonly StripTab[];
  readonly selectedKey: string | null;
  readonly projects: readonly ProjectViewDto[];
  readonly onSelect: (tab: StripTab) => void;
  readonly onNew: () => void;
}

function titleOf(tab: StripTab): string {
  return tab.kind === 'chat' ? tab.chat.title : CHAT_DEFAULT_TITLE;
}

/** The tabs in the header's slot: a tile and a title each, and New Session. */
export function TabStrip({ tabs, selectedKey, projects, onSelect, onNew }: TabStripProps) {
  return (
    <Group gap={4} wrap="nowrap" role="tablist" aria-label="Sessions" style={{ minWidth: 0 }}>
      {tabs.map((tab) => {
        const projectId = tab.kind === 'chat' ? tab.chat.projectId : tab.tab.projectId;
        const name = projects.find((p) => p.id === projectId)?.name ?? '';
        const selected = tab.key === selectedKey;
        return (
          <UnstyledButton
            key={tab.key}
            role="tab"
            aria-selected={selected}
            onClick={() => {
              onSelect(tab);
            }}
            px="xs"
            h={32}
            style={{
              borderRadius: 'var(--mantine-radius-sm)',
              background: selected ? 'var(--mantine-color-default-hover)' : undefined,
              minWidth: 0,
            }}
          >
            <Group gap={6} wrap="nowrap">
              <ProjectTile name={name} size={16} />
              <Text size="sm" lineClamp={1} maw={160}>
                {titleOf(tab)}
              </Text>
            </Group>
          </UnstyledButton>
        );
      })}
      <ActionIcon variant="subtle" aria-label="New Session" onClick={onNew}>
        <IconPlus size={16} stroke={1.5} />
      </ActionIcon>
    </Group>
  );
}
