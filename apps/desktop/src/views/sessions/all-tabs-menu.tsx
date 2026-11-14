import { Box, Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { CountBadge } from '../../shell/count-badge';
import { ProjectTile } from '../../shell/project-tile';
import type { TabInfo } from './tab-info';
import { tabTitle, type StripTab } from './strip-tabs';

export interface AllTabsMenuProps {
  readonly tabs: readonly StripTab[];
  readonly infos: ReadonlyMap<string, TabInfo>;
  readonly projectName: (tab: StripTab) => string;
  /** Tabs scrolled out of the strip that need the builder. */
  readonly hiddenNeedingYou: number;
  readonly onSelect: (tab: StripTab) => void;
}

/** All Tabs: every open tab with its tile, title and state, so a scrolled-away tab is still reachable. */
export function AllTabsMenu({
  tabs,
  infos,
  projectName,
  hiddenNeedingYou,
  onSelect,
}: AllTabsMenuProps) {
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <UnstyledButton
          aria-label={
            hiddenNeedingYou === 0
              ? 'All Tabs'
              : `All Tabs, ${String(hiddenNeedingYou)} hidden need you`
          }
          h={30}
          px={6}
          style={{ borderRadius: 'var(--mantine-radius-md)', flex: 'none' }}
        >
          <Group gap={4} wrap="nowrap">
            <IconChevronDown size={16} stroke={1.5} />
            {hiddenNeedingYou === 0 ? null : <CountBadge count={hiddenNeedingYou} />}
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>All Tabs</Menu.Label>
        {tabs.map((tab) => {
          const info = infos.get(tab.key);
          return (
            <Menu.Item
              key={tab.key}
              leftSection={<ProjectTile name={projectName(tab)} size={16} />}
              rightSection={
                info === undefined || info.words.spoken === '' ? null : (
                  <Text size="xs" c="dimmed">
                    {info.words.spoken}
                  </Text>
                )
              }
              onClick={() => {
                onSelect(tab);
              }}
            >
              <Box maw={220}>
                <Text size="sm" lineClamp={1}>
                  {tabTitle(tab)}
                </Text>
              </Box>
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}
