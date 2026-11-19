import {
  CHAT_DEFAULT_TITLE,
  type ChatDto,
  type ProjectId,
  type ProjectViewDto,
} from '@10db/contracts';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ActionIcon, Box, Menu, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconFolder, IconFolderOpen, IconPlus } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchChats } from '../../daemon/chat-queries';
import { Panel } from '../../shell/panel';
import { PanelSearch } from '../../shell/panel-search';
import { ProjectTile } from '../../shell/project-tile';
import { canOpenTerminal } from './can-open-terminal';
import { readCollapsed, writeCollapsed } from './collapsed-projects';
import { dropTarget, panelRowProject, type PanelGroup, type PanelRow } from './panel-order';
import type { RowState } from './row-state';
import { SessionRow } from './session-row';
import classes from './session-row.module.css';
import { SessionMenuItems } from './session-menu';
import { sessionName } from './tab-info';

/** Up to this many rows the panel draws every row; past it, only the rows in view. */
export const VIRTUAL_FROM = 200;

const ROW_HEIGHT = 32;
const GROUP_HEIGHT = 32;

type Item =
  | { readonly kind: 'group'; readonly projectId: ProjectId }
  | { readonly kind: 'row'; readonly row: PanelRow };

export interface SessionsPanelProps {
  readonly groups: readonly PanelGroup[];
  readonly projects: readonly ProjectViewDto[];
  readonly selectedKey: string | null;
  /** What each chat row shows; a fresh row shows none. */
  readonly states: ReadonlyMap<string, RowState>;
  readonly onSelect: (row: PanelRow) => void;
  readonly onClose: (row: PanelRow) => void;
  readonly onNew: () => void;
  readonly onRename: (row: PanelRow) => void;
  readonly onArchive: (row: PanelRow) => void;
  readonly onOpenInTerminal: (row: PanelRow) => void;
  readonly onMakeTask: (row: PanelRow) => void;
  /** A session was dragged to the place of another in its project. */
  readonly onReorder: (chat: ChatDto, position: number) => void;
  /** A session a search found: closed and archived ones come back first. */
  readonly onOpenFound: (chat: ChatDto) => void;
}

/** The sessions of a project that is no longer in the list are grouped under these words, with no mark. */
const REMOVED_PROJECT = 'Removed project';

function Group_({
  name,
  projectsKnown,
  open,
  onToggle,
}: {
  readonly name: string;
  /** Whether the project list has arrived; until it has, a group's name is unknown, not removed. */
  readonly projectsKnown: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  const label = name !== '' ? name : projectsKnown ? REMOVED_PROJECT : '';
  return (
    // A label of the list, not a control in it: a listbox holds only its options, so the fold is the pointer's.
    <div
      role="presentation"
      className={classes['group']}
      data-open={open ? '' : undefined}
      onClick={onToggle}
    >
      {open ? (
        <IconFolderOpen size={16} stroke={1.5} className={classes['folder']} aria-hidden="true" />
      ) : (
        <IconFolder size={16} stroke={1.5} className={classes['folder']} aria-hidden="true" />
      )}
      <span className={classes['groupName']}>{label}</span>
    </div>
  );
}

function Found({
  chat,
  projectName,
  onOpen,
}: {
  readonly chat: ChatDto;
  readonly projectName: string;
  readonly onOpen: () => void;
}): ReactNode {
  const how = chat.archivedAt !== null ? 'archived' : chat.tabPosition === null ? 'closed' : 'open';
  return (
    <div role="listitem">
      <UnstyledButton
        className={classes['row']}
        onClick={onOpen}
        aria-label={`${chat.title}, ${projectName}, ${how}`}
      >
        <ProjectTile name={projectName} size={14} />
        <span className={classes['title']}>{chat.title}</span>
        {how === 'open' ? null : (
          <Text size="xs" c="dimmed">
            {how}
          </Text>
        )}
      </UnstyledButton>
    </div>
  );
}

/**
 * The Sessions panel (shell spec §1.3): every open session by project, a search across all of them, a
 * right-click menu and drag to reorder; Recently closed is the title switcher's. Past 200 rows only the rows in
 * view are drawn, and drag is off, since a row that is not drawn cannot be a drop.
 */
export function SessionsPanel(props: SessionsPanelProps): ReactNode {
  const { groups, projects, selectedKey, states } = props;
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{
    readonly row: PanelRow;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const search = useSearchChats(query);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);
  const toggle = (projectId: ProjectId): void => {
    setCollapsed((now) => {
      const next = new Set(now);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };
  const isOpen = (g: PanelGroup): boolean => !collapsed.has(g.projectId);
  // A folded group still shows the selected session, as Slack's folded sections do, so the row the content
  // shows is always in the list.
  const shownRows = (g: PanelGroup): readonly PanelRow[] =>
    isOpen(g) ? g.rows : g.rows.filter((r) => r.key === selectedKey);
  const scroller = useRef<HTMLDivElement | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const nameOf = (id: ProjectId): string => projects.find((p) => p.id === id)?.name ?? '';
  const items: Item[] = groups.flatMap((g): Item[] => [
    { kind: 'group', projectId: g.projectId },
    ...shownRows(g).map((row): Item => ({ kind: 'row', row })),
  ]);
  const rowCount = items.filter((i) => i.kind === 'row').length;
  const virtual = rowCount > VIRTUAL_FROM;
  const searching = query.trim() !== '';

  // The compiler skips this component, as it does the conversation list: the virtualizer's functions cannot be memoized.
  // eslint-disable-next-line react-hooks/incompatible-library -- the skip is intended.
  const virtualizer = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (items[i]?.kind === 'group' ? GROUP_HEIGHT : ROW_HEIGHT),
    // Keyed by what each item is, so a fold that keeps the count still gives a header and a row their own sizes.
    getItemKey: (i) => {
      const item = items[i];
      if (item === undefined) return i;
      return item.kind === 'group' ? `group:${item.projectId}` : item.row.key;
    },
    overscan: 12,
    // Until the list is measured, a panel's worth of rows is drawn.
    initialRect: { width: 260, height: 600 },
  });

  // Tab reaches the selected row, or the first one while none is selected.
  const allRows = items.flatMap((i) => (i.kind === 'row' ? [i.row] : []));
  const tabbableKey = (allRows.find((r) => r.key === selectedKey) ?? allRows[0])?.key ?? null;

  // The selected row stays in view when a key, not a click, selected it.
  const selectedIndex = items.findIndex((i) => i.kind === 'row' && i.row.key === selectedKey);
  useEffect(() => {
    if (selectedIndex < 0) return;
    if (virtual) virtualizer.scrollToIndex(selectedIndex);
    else {
      const row = scroller.current?.querySelector('[role="option"][aria-selected="true"]');
      if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function')
        row.scrollIntoView({ block: 'nearest' });
    }
    // Only a change of the selected row scrolls; the virtualizer is a new object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, virtual]);

  const renderRow = (row: PanelRow): ReactNode => {
    const project = nameOf(panelRowProject(row));
    if (row.kind === 'fresh') {
      return (
        <SessionRow
          key={row.key}
          rowKey={row.key}
          title="New Session"
          fresh
          name={sessionName(CHAT_DEFAULT_TITLE, project, '')}
          detail={project}
          selected={row.key === selectedKey}
          tabbable={row.key === tabbableKey}
          draggable={false}
          onSelect={() => {
            props.onSelect(row);
          }}
          onClose={() => {
            props.onClose(row);
          }}
          onRename={() => undefined}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ row, x: event.clientX, y: event.clientY });
          }}
        />
      );
    }
    const state = states.get(row.key);
    const label = row.chat.conversation.capabilities.label;
    return (
      <SessionRow
        key={row.key}
        rowKey={row.key}
        title={row.chat.title}
        {...(state === undefined ? {} : { state })}
        name={sessionName(row.chat.title, project, state?.spoken ?? '')}
        detail={[project, label].filter((p) => p !== '').join(' · ')}
        selected={row.key === selectedKey}
        tabbable={row.key === tabbableKey}
        draggable={!virtual && !searching}
        onSelect={() => {
          props.onSelect(row);
        }}
        onClose={() => {
          props.onClose(row);
        }}
        onRename={() => {
          props.onRename(row);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ row, x: event.clientX, y: event.clientY });
        }}
      />
    );
  };

  const dragEnd = ({ active, over }: DragEndEvent): void => {
    if (over === null) return;
    const drop = dropTarget(
      groups.flatMap((g) => g.rows),
      String(active.id),
      String(over.id),
    );
    if (drop !== null) props.onReorder(drop.chat, drop.position);
  };

  const header = (g: PanelGroup): ReactNode => (
    <Group_
      name={nameOf(g.projectId)}
      projectsKnown={projects.length > 0}
      open={isOpen(g)}
      onToggle={() => {
        toggle(g.projectId);
      }}
    />
  );
  const groupHeaderOf = (projectId: ProjectId): ReactNode => {
    const g = groups.find((group) => group.projectId === projectId);
    return g === undefined ? null : header(g);
  };

  const list = (
    <div role="listbox" aria-label="Sessions" style={{ outline: 'none' }}>
      {groups.map((g) => (
        <div key={g.projectId} role="presentation">
          {header(g)}
          {shownRows(g).map(renderRow)}
        </div>
      ))}
    </div>
  );

  const virtualList = (
    <div
      role="listbox"
      aria-label="Sessions"
      style={{ height: virtualizer.getTotalSize(), position: 'relative', outline: 'none' }}
    >
      {virtualizer.getVirtualItems().map((v) => {
        const item = items[v.index];
        if (item === undefined) return null;
        return (
          <div
            key={v.key}
            role="presentation"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: v.size,
              transform: `translateY(${String(v.start)}px)`,
            }}
          >
            {item.kind === 'group' ? groupHeaderOf(item.projectId) : renderRow(item.row)}
          </div>
        );
      })}
    </div>
  );

  const menuChat = menu?.row.kind === 'chat' ? menu.row.chat : null;
  return (
    <Panel
      section="sessions"
      title="Sessions"
      controls={
        <Tooltip label="New Session ⌘T" openDelay={500}>
          <ActionIcon variant="subtle" aria-label="New Session" onClick={props.onNew}>
            <IconPlus size={16} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      }
    >
      <Box
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
        aria-label="Sessions panel"
        component="nav"
      >
        <Box pt={4} pb={12}>
          <PanelSearch
            aria-label="Search sessions"
            placeholder="Search sessions"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
            }}
          />
        </Box>
        <div
          ref={scroller}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none' }}
        >
          {searching ? (
            <>
              <div role="list" aria-label="Search results">
                {search.rows.map((chat) => (
                  <Found
                    key={chat.id}
                    chat={chat}
                    projectName={nameOf(chat.projectId)}
                    onOpen={() => {
                      props.onOpenFound(chat);
                      setQuery('');
                    }}
                  />
                ))}
              </div>
              {search.rows.length === 0 && !search.isFetching ? (
                <Text size="xs" c="dimmed" px="xs" py="xs">
                  No session matches.
                </Text>
              ) : null}
            </>
          ) : virtual ? (
            virtualList
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
              <SortableContext
                items={groups.flatMap((g) =>
                  shownRows(g)
                    .filter((r) => r.kind === 'chat')
                    .map((r) => r.key),
                )}
                strategy={verticalListSortingStrategy}
              >
                {list}
              </SortableContext>
            </DndContext>
          )}
        </div>
      </Box>
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
            <SessionMenuItems
              actions={{
                ...(menuChat === null
                  ? {}
                  : {
                      onRename: () => {
                        props.onRename(menu.row);
                      },
                      ...(canOpenTerminal(menuChat.conversation) &&
                      projects.some((p) => p.id === menuChat.projectId)
                        ? {
                            onOpenInTerminal: () => {
                              props.onOpenInTerminal(menu.row);
                            },
                          }
                        : {}),
                      onMakeTask: () => {
                        props.onMakeTask(menu.row);
                      },
                      onArchive: () => {
                        props.onArchive(menu.row);
                      },
                    }),
                onClose: () => {
                  props.onClose(menu.row);
                },
              }}
            />
          )}
        </Menu.Dropdown>
      </Menu>
    </Panel>
  );
}
