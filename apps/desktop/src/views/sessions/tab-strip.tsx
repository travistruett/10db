import type { ConversationId, InboxItemDto, ProjectViewDto } from '@10db/contracts';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { ActionIcon, Box, Group, Menu, Tooltip } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { IconPlus } from '@tabler/icons-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { EdgeFade } from '../../shell/edge-fade';
import { useHiddenEdges } from '../../shell/use-hidden-edges';
import { AllTabsMenu } from './all-tabs-menu';
import { canOpenTerminal } from './can-open-terminal';
import type { ClosedTab } from './closed-tabs';
import { TabMenuItems } from './tab-menu';
import { SessionTab } from './session-tab';
import { tabTitle, tabProjectId, type StripTab } from './strip-tabs';
import { tabInfo, type TabInfo } from './tab-info';
import { useStripLayout } from './strip-layout';
import { needsYou, tabWidths } from './tab-state';

export type { StripTab } from './strip-tabs';

/** A tab's width before the strip squeezes it: tile, gaps and the mark, plus the title at about 7 px a letter. */
function naturalWidth(title: string): number {
  return 16 + 14 + 6 * 2 + 16 + title.length * 7;
}

/** What New Session, All Tabs and the strip's gaps take beside the tabs. */
const CONTROLS_WIDTH = 96;

/** The panel a tab controls. */
export const panelId = (key: string): string => `session-panel-${key}`;

export interface TabStripProps {
  readonly tabs: readonly StripTab[];
  readonly selectedKey: string | null;
  readonly projects: readonly ProjectViewDto[];
  readonly cards: ReadonlyMap<ConversationId, InboxItemDto[]>;
  readonly seen: Readonly<Record<string, string>>;
  readonly onSelect: (tab: StripTab) => void;
  readonly onClose: (tab: StripTab) => void;
  readonly onNew: () => void;
  readonly closed: readonly ClosedTab[];
  readonly onReopen: (entry: ClosedTab) => void;
  readonly onRename: (tab: StripTab) => void;
  readonly onOpenInTerminal: (tab: StripTab) => void;
  readonly onArchive: (tab: StripTab) => void;
  readonly onCloseOthers: (tab: StripTab) => void;
  /** A chat's tab was dragged to this place. */
  readonly onReorder: (tab: StripTab, position: number) => void;
}

/** Which tabs lie wholly or partly outside the scroll area. */
function hiddenKeys(container: HTMLElement): ReadonlySet<string> {
  const hidden = new Set<string>();
  const left = container.scrollLeft;
  const right = left + container.clientWidth;
  for (const element of container.querySelectorAll<HTMLElement>('[data-session-tab]')) {
    const start = element.offsetLeft;
    const end = start + element.offsetWidth;
    if (start < left - 1 || end > right + 1) hidden.add(element.dataset['sessionTab'] ?? '');
  }
  return hidden;
}

/** The tabs in the header's slot: a pill each, New Session and All Tabs. */
export function TabStrip({
  tabs,
  selectedKey,
  projects,
  cards,
  seen,
  onSelect,
  onClose,
  onNew,
  closed,
  onReopen,
  onRename,
  onOpenInTerminal,
  onArchive,
  onCloseOthers,
  onReorder,
}: TabStripProps) {
  const [menu, setMenu] = useState<{
    readonly tab: StripTab;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const layout = useStripLayout();
  const compact = layout !== 'full';
  const { ref: sizeRef, width: available } = useElementSize();
  const { ref: edgesRef, edges, onScroll } = useHiddenEdges();
  const list = useRef<HTMLDivElement | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const projectName = (tab: StripTab): string =>
    projects.find((p) => p.id === tabProjectId(tab))?.name ?? '';
  const hasProject = (id: string): boolean => projects.some((p) => p.id === id);
  const infos = new Map<string, TabInfo>(tabs.map((tab) => [tab.key, tabInfo(tab, cards, seen)]));
  const selectedIndex = tabs.findIndex((t) => t.key === selectedKey);
  const room = available - CONTROLS_WIDTH;
  const widths =
    room > 0
      ? tabWidths(
          tabs.map((t) => naturalWidth(tabTitle(t))),
          selectedIndex,
          room,
        )
      : null;

  const measure = (): void => {
    const container = list.current;
    if (container === null) return;
    const next = hiddenKeys(container);
    setHidden((held) =>
      held.size === next.size && [...next].every((k) => held.has(k)) ? held : next,
    );
  };
  const scrolled = (): void => {
    onScroll();
    measure();
  };
  useEffect(measure);

  const hiddenNeedingYou = tabs.filter(
    (t) => hidden.has(t.key) && needsYou(infos.get(t.key)?.state ?? 'idle'),
  ).length;

  const selectedTab = tabs[selectedIndex];
  const othersNeeding = tabs.filter(
    (t) => t.key !== selectedKey && needsYou(infos.get(t.key)?.state ?? 'idle'),
  ).length;
  const allTabs = (needing: number, current: StripTab | null) => (
    <AllTabsMenu
      switcher={
        current === null
          ? null
          : {
              tab: current,
              info: infos.get(current.key) ?? tabInfo(current, cards, seen),
              projectName: projectName(current),
            }
      }
      tabs={tabs}
      infos={infos}
      projectName={projectName}
      hiddenNeedingYou={needing}
      closed={closed}
      projectNameOf={(id) => projects.find((p) => p.id === id)?.name ?? ''}
      onSelect={onSelect}
      onReopen={onReopen}
    />
  );

  const move = (from: HTMLElement, by: number): void => {
    const all = [...(list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    all[all.indexOf(from) + by]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'tab') return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      move(target, event.key === 'ArrowRight' ? 1 : -1);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      const tab = tabs.find((t) => t.key === target.dataset['sessionTab']);
      if (tab !== undefined) onClose(tab);
    }
  };

  const dragEnd = ({ active, over }: DragEndEvent): void => {
    if (over === null || active.id === over.id) return;
    const moved = tabs.find((t) => t.key === active.id);
    const target = tabs.find((t) => t.key === over.id);
    if (moved?.kind === 'chat' && target !== undefined) onReorder(moved, target.position);
  };

  return (
    <Group
      gap={4}
      wrap="nowrap"
      data-tauri-drag-region
      style={{ flex: 1, minWidth: 0, alignSelf: 'stretch' }}
      ref={sizeRef}
    >
      {layout === 'switcher' ? (
        selectedTab === undefined ? null : (
          allTabs(othersNeeding, selectedTab)
        )
      ) : (
        <Box pos="relative" style={{ minWidth: 0, flex: '0 1 auto' }}>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
            <SortableContext
              items={tabs.filter((t) => t.kind === 'chat').map((t) => t.key)}
              strategy={horizontalListSortingStrategy}
            >
              {/* The tabs hold the roving focus; the list itself is not a stop. */}
              {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus */}
              <div
                ref={(node) => {
                  list.current = node;
                  edgesRef(node);
                }}
                role="tablist"
                aria-label="Sessions"
                aria-orientation="horizontal"
                onScroll={scrolled}
                onKeyDown={onKeyDown}
                style={{
                  display: 'flex',
                  gap: 4,
                  alignItems: 'center',
                  overflowX: 'auto',
                  scrollbarWidth: 'none',
                }}
              >
                {tabs.map((tab, index) => {
                  const info = infos.get(tab.key) ?? tabInfo(tab, cards, seen);
                  const selected = tab.key === selectedKey;
                  const label = tab.kind === 'chat' ? tab.chat.conversation.capabilities.label : '';
                  const model = tab.kind === 'chat' ? (tab.chat.conversation.model ?? '') : '';
                  return (
                    <SessionTab
                      key={tab.key}
                      tab={tab}
                      projectName={projectName(tab)}
                      info={info}
                      selected={selected}
                      width={widths?.[index] ?? null}
                      compact={compact}
                      kindLine={`${projectName(tab)} · Chat${label === '' ? '' : ` · ${label} ${model}`.trimEnd()}`}
                      panelId={selected ? panelId(tab.key) : null}
                      onSelect={() => {
                        onSelect(tab);
                      }}
                      onClose={() => {
                        onClose(tab);
                      }}
                      onRename={() => {
                        onRename(tab);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setMenu({ tab, x: event.clientX, y: event.clientY });
                      }}
                    />
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>
          <EdgeFade side="left" shown={edges.left} color="var(--mantine-color-body)" depth={24} />
          <EdgeFade side="right" shown={edges.right} color="var(--mantine-color-body)" depth={24} />
        </Box>
      )}
      <Tooltip label="New Session ⌘T" openDelay={500}>
        <ActionIcon variant="subtle" aria-label="New Session" onClick={onNew}>
          <IconPlus size={16} stroke={1.5} />
        </ActionIcon>
      </Tooltip>
      {layout === 'switcher' ? null : allTabs(hiddenNeedingYou, null)}
      <Menu
        opened={menu !== null}
        onClose={() => {
          setMenu(null);
        }}
        position="bottom-start"
        withinPortal
      >
        <Menu.Target>
          <Box
            aria-hidden="true"
            style={{
              position: 'fixed',
              left: menu?.x ?? 0,
              top: menu?.y ?? 0,
              width: 0,
              height: 0,
            }}
          />
        </Menu.Target>
        <Menu.Dropdown>
          {menu === null ? null : (
            <TabMenuItems
              actions={{
                ...(menu.tab.kind === 'chat'
                  ? {
                      onRename: () => {
                        onRename(menu.tab);
                      },
                      onArchive: () => {
                        onArchive(menu.tab);
                      },
                      // A chat whose project is gone has no folder to open a terminal in.
                      ...(canOpenTerminal(menu.tab.chat.conversation) &&
                      hasProject(menu.tab.chat.projectId)
                        ? {
                            onOpenInTerminal: () => {
                              onOpenInTerminal(menu.tab);
                            },
                          }
                        : {}),
                    }
                  : {}),
                onClose: () => {
                  onClose(menu.tab);
                },
                onCloseOthers: () => {
                  onCloseOthers(menu.tab);
                },
                othersOpen: tabs.length > 1,
              }}
            />
          )}
        </Menu.Dropdown>
      </Menu>
      <Box data-tauri-drag-region style={{ flex: 1, alignSelf: 'stretch', minWidth: 8 }} />
    </Group>
  );
}
