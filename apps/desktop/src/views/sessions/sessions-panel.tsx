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
import { IconPlus } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchChats } from '../../daemon/chat-queries';
import { Panel } from '../../shell/panel';
import { PanelSearch } from '../../shell/panel-search';
import { ProjectTile } from '../../shell/project-tile';
import { canOpenTerminal } from './can-open-terminal';
import type { ClosedChat } from './closed-tabs';
import { dropTarget, panelRowProject, type PanelGroup, type PanelRow } from './panel-order';
import type { RowState } from './row-state';
import { SessionRow } from './session-row';
import classes from './session-row.module.css';
import { SessionMenuItems } from './session-menu';
import { sessionName } from './tab-info';

/** Up to this many rows the panel draws every row; past it, only the rows in view. */
export const VIRTUAL_FROM = 200;

const ROW_HEIGHT = 32;
const GROUP_HEIGHT = 34;

type Item =
  | { readonly kind: 'group'; readonly projectId: ProjectId }
  | { readonly kind: 'row'; readonly row: PanelRow };

export interface SessionsPanelProps {
  readonly groups: readonly PanelGroup[];
  readonly projects: readonly ProjectViewDto[];
  readonly selectedKey: string | null;
  /** What each chat row shows; a fresh row shows none. */
  readonly states: ReadonlyMap<string, RowState>;
  /** Recently closed sessions, newest first. */
  readonly closed: readonly ClosedChat[];
  readonly onSelect: (row: PanelRow) => void;
  readonly onClose: (row: PanelRow) => void;
  readonly onNew: () => void;
  readonly onRename: (row: PanelRow) => void;
  readonly onArchive: (row: PanelRow) => void;
  readonly onOpenInTerminal: (row: PanelRow) => void;
  readonly onMakeTask: (row: PanelRow) => void;
  /** A session was dragged to the place of another in its project. */
  readonly onReorder: (chat: ChatDto, position: number) => void;
  readonly onReopen: (entry: ClosedChat) => void;
  /** A session a search found: closed and archived ones come back first. */
  readonly onOpenFound: (chat: ChatDto) => void;
}

/** The sessions of a project that is no longer in the list are grouped under these words, with no mark. */
const REMOVED_PROJECT = 'Removed project';

function Group_({ name }: { readonly name: string }): ReactNode {
  return (
    <div className={classes['group']} role="presentation">
      {name === '' ? null : <ProjectTile name={name} size={14} />}
      <span>{name === '' ? REMOVED_PROJECT : name}</span>
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
 * right-click menu, drag to reorder and the last five closed at the foot. Past 200 rows only the rows in
 * view are drawn, and drag is off, since a row that is not drawn cannot be a drop.
 */
export function SessionsPanel(props: SessionsPanelProps): ReactNode {
  const { groups, projects, selectedKey, states, closed } = props;
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{
    readonly row: PanelRow;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const search = useSearchChats(query);
  const scroller = useRef<HTMLDivElement | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const nameOf = (id: ProjectId): string => projects.find((p) => p.id === id)?.name ?? '';
  const items: Item[] = groups.flatMap((g): Item[] => [
    { kind: 'group', projectId: g.projectId },
    ...g.rows.map((row): Item => ({ kind: 'row', row })),
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

  const list = (
    <div role="listbox" aria-label="Sessions" style={{ outline: 'none' }}>
      {groups.map((g) => (
        <div key={g.projectId} role="presentation">
          <Group_ name={nameOf(g.projectId)} />
          {g.rows.map(renderRow)}
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
            {item.kind === 'group' ? <Group_ name={nameOf(item.projectId)} /> : renderRow(item.row)}
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
                  g.rows.filter((r) => r.kind === 'chat').map((r) => r.key),
                )}
                strategy={verticalListSortingStrategy}
              >
                {list}
              </SortableContext>
            </DndContext>
          )}
        </div>
        {closed.length === 0 ? null : (
          <Box
            pt={10}
            mt={4}
            style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
          >
            <Text size="xs" fw={600} c="dimmed" px={12} pb={4}>
              Recently closed
            </Text>
            {closed.map((entry) => (
              <UnstyledButton
                key={entry.chatId}
                className={classes['row']}
                onClick={() => {
                  props.onReopen(entry);
                }}
                aria-label={`Reopen ${entry.title}`}
              >
                <ProjectTile name={nameOf(entry.projectId)} size={14} />
                <span className={classes['title']}>{entry.title}</span>
              </UnstyledButton>
            ))}
          </Box>
        )}
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
