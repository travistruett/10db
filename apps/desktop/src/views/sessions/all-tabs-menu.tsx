import { Box, Group, Menu, Text, UnstyledButton, VisuallyHidden } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { CountBadge, CountTone } from '../../shell/count-badge';
import { ProjectTile } from '../../shell/project-tile';
import { closedId, type ClosedTab } from './closed-tabs';
import { tabName, type TabInfo } from './tab-info';
import { Mark } from './session-tab';
import { tabTitle, type StripTab } from './strip-tabs';

/** The selected tab as the one control of a narrow window's header. */
export interface SwitcherTab {
  readonly tab: StripTab;
  readonly info: TabInfo;
  readonly projectName: string;
}

export interface AllTabsMenuProps {
  /** Under 640 px the menu's button is the switcher: the selected tab's tile, title and state. */
  readonly switcher?: SwitcherTab | null;
  readonly tabs: readonly StripTab[];
  readonly infos: ReadonlyMap<string, TabInfo>;
  readonly projectName: (tab: StripTab) => string;
  /** Tabs scrolled out of the strip that need the builder. */
  readonly hiddenNeedingYou: number;
  /** The last closed tabs, newest first. */
  readonly closed: readonly ClosedTab[];
  readonly projectNameOf: (projectId: string) => string;
  readonly onSelect: (tab: StripTab) => void;
  readonly onReopen: (entry: ClosedTab) => void;
}

/** All Tabs: every open tab with its tile, title and state, so a scrolled-away tab is still reachable. */
export function AllTabsMenu({
  switcher = null,
  tabs,
  infos,
  projectName,
  hiddenNeedingYou,
  closed,
  projectNameOf,
  onSelect,
  onReopen,
}: AllTabsMenuProps) {
  return (
    <>
      {switcher === null ? null : (
        // The panel is labelled by the selected tab, which the switcher stands for.
        <VisuallyHidden id={`session-tab-${switcher.tab.key}`}>
          {tabName(tabTitle(switcher.tab), switcher.projectName, switcher.info)}
        </VisuallyHidden>
      )}
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <UnstyledButton
            aria-label={
              switcher === null
                ? hiddenNeedingYou === 0
                  ? 'All Tabs'
                  : `All Tabs, ${String(hiddenNeedingYou)} hidden need you`
                : `${tabName(tabTitle(switcher.tab), switcher.projectName, switcher.info)}. All Tabs${
                    hiddenNeedingYou === 0 ? '' : `, ${String(hiddenNeedingYou)} others need you`
                  }`
            }
            h={30}
            px={6}
            style={{
              borderRadius: 'var(--mantine-radius-md)',
              flex: switcher === null ? 'none' : '0 1 auto',
              minWidth: 0,
            }}
          >
            <Group gap={6} wrap="nowrap">
              {switcher === null ? null : (
                <>
                  <ProjectTile name={switcher.projectName} size={16} />
                  <Text size="sm" fw={600} lineClamp={1} style={{ minWidth: 0 }}>
                    {tabTitle(switcher.tab)}
                  </Text>
                  <Mark mark={switcher.info.words.mark} />
                </>
              )}
              <IconChevronDown size={16} stroke={1.5} />
              {hiddenNeedingYou === 0 ? null : (
                <CountBadge count={hiddenNeedingYou} tone={CountTone.Attention} />
              )}
            </Group>
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
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
          {closed.length === 0 ? null : (
            <>
              <Text size="xs" c="dimmed" fw={600} px="sm" pt="xs" aria-hidden="true">
                Recently Closed
              </Text>
              {closed.map((entry) => (
                <Menu.Item
                  key={closedId(entry)}
                  aria-label={`Reopen ${entry.title}`}
                  leftSection={<ProjectTile name={projectNameOf(entry.projectId)} size={16} />}
                  rightSection={
                    <Text size="xs" c="dimmed">
                      {'archived' in entry && entry.archived === true
                        ? 'Archived · Reopen'
                        : 'Reopen'}
                    </Text>
                  }
                  onClick={() => {
                    onReopen(entry);
                  }}
                >
                  <Box maw={200}>
                    <Text
                      size="sm"
                      lineClamp={1}
                      {...('archived' in entry && entry.archived === true ? { c: 'dimmed' } : {})}
                    >
                      {entry.title}
                    </Text>
                  </Box>
                </Menu.Item>
              ))}
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    </>
  );
}
