import { Box, Text, Tooltip } from '@mantine/core';
import { useHover } from '@mantine/hooks';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  IconAlertTriangle,
  IconFolder,
  IconGitBranch,
  IconPlayerPause,
  IconX,
} from '@tabler/icons-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ProjectTile } from '../../shell/project-tile';
import { tabName, type TabInfo } from './tab-info';
import { tabTitle, type StripTab } from './strip-tabs';
import type { TabWords } from './tab-state';

const RING_COLOR = {
  yellow: 'var(--mantine-color-yellow-filled)',
  red: 'var(--mantine-color-red-filled)',
} as const;

/** The state mark at the tab's right: a dot or a glyph, each with a shape of its own. */
export function Mark({ mark }: { readonly mark: TabWords['mark'] }) {
  switch (mark) {
    case 'dot_blue':
    case 'dot_yellow':
      return (
        <Box
          data-mark={mark}
          w={8}
          h={8}
          style={{
            borderRadius: '50%',
            background:
              mark === 'dot_blue'
                ? 'var(--mantine-color-blue-filled)'
                : 'var(--mantine-color-yellow-filled)',
          }}
        />
      );
    case 'alert_red':
      return (
        <IconAlertTriangle
          data-mark={mark}
          size={12}
          stroke={1.5}
          color="var(--mantine-color-red-filled)"
        />
      );
    case 'pause_orange':
      return (
        <IconPlayerPause
          data-mark={mark}
          size={12}
          stroke={1.5}
          color="var(--mantine-color-orange-filled)"
        />
      );
    case null:
      return null;
  }
}

export interface SessionTabProps {
  readonly tab: StripTab;
  readonly projectName: string;
  readonly info: TabInfo;
  readonly selected: boolean;
  /** The width the strip gives it; null lets the title decide. */
  readonly width: number | null;
  /** Only the tile and the state show: an unselected tab in a narrow window. */
  readonly compact: boolean;
  /** The kind and model line of the tooltip. */
  readonly kindLine: string;
  readonly onSelect: () => void;
  readonly onClose: () => void;
  readonly onRename: () => void;
  readonly onContextMenu: (event: React.MouseEvent) => void;
  readonly panelId: string | null;
  readonly children?: ReactNode;
}

/**
 * One tab, a 30 px pill (sessions UI spec §5.2): the project's tile, the title, one state mark. Hovered
 * and selected, × takes the mark's place, so it adds no width; a ring stays around a tab that needs you.
 */
export function SessionTab({
  tab,
  projectName,
  info,
  selected,
  width,
  compact,
  kindLine,
  onSelect,
  onClose,
  onRename,
  onContextMenu,
  panelId,
}: SessionTabProps) {
  // dnd-kit's sortable handle is a bag of refs and listeners the compiler cannot analyze.
  'use no memo';
  const { hovered, ref: hoverRef } = useHover<HTMLDivElement>();
  const sortable = useSortable({ id: tab.key, disabled: tab.kind !== 'chat' });
  const title = tabTitle(tab);
  const ring = info.words.ring;
  const showClose = hovered || selected;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' && event.target === event.currentTarget) {
      event.preventDefault();
      onSelect();
    }
  };

  return (
    <Tooltip
      openDelay={500}
      withinPortal
      multiline
      disabled={sortable.isDragging}
      label={
        <>
          <Text size="xs" fw={600}>
            {title}
          </Text>
          <Text size="xs">{kindLine}</Text>
          {info.words.spoken === '' ? null : <Text size="xs">{info.words.spoken}</Text>}
        </>
      }
    >
      <div
        ref={(node) => {
          sortable.setNodeRef(node);
          hoverRef(node);
        }}
        role="tab"
        id={`session-tab-${tab.key}`}
        aria-selected={selected}
        {...(panelId === null ? {} : { 'aria-controls': panelId })}
        aria-label={tabName(title, projectName, info)}
        tabIndex={selected ? 0 : -1}
        data-session-tab={tab.key}
        {...(ring === null ? {} : { 'data-ring': ring })}
        data-state={info.state}
        aria-describedby={sortable.attributes['aria-describedby']}
        {...sortable.listeners}
        onClick={onSelect}
        onDoubleClick={onRename}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flex: 'none',
          height: 30,
          width: width ?? undefined,
          maxWidth: 220,
          paddingInline: 8,
          borderRadius: 'var(--mantine-radius-md)',
          cursor: 'pointer',
          userSelect: 'none',
          background: hovered || selected ? 'var(--mantine-color-default-hover)' : 'transparent',
          boxShadow: ring === null ? undefined : `inset 0 0 0 1px ${RING_COLOR[ring]}`,
          // A tab slides along the strip only.
          transform: CSS.Transform.toString(
            sortable.transform === null ? null : { ...sortable.transform, y: 0 },
          ),
          transition: sortable.transition,
          opacity: sortable.isDragging ? 0.6 : 1,
        }}
      >
        <ProjectTile name={projectName} size={16} />
        {tab.kind === 'task' ? (
          <Box
            component="span"
            aria-hidden="true"
            data-glyph={tab.task.place === 'pass' ? 'folder' : 'git-branch'}
            c="dimmed"
            style={{ flex: 'none', display: 'grid', placeItems: 'center' }}
          >
            {tab.task.place === 'pass' ? (
              <IconFolder size={12} stroke={1.5} />
            ) : (
              <IconGitBranch size={12} stroke={1.5} />
            )}
          </Box>
        ) : null}
        {compact && !selected ? null : (
          <Text
            size="sm"
            lineClamp={1}
            fw={selected || info.words.bold ? 600 : 400}
            {...(selected || ring !== null || info.words.bold ? { c: 'bright' } : {})}
            style={{ flex: 1, minWidth: 0 }}
          >
            {title}
          </Text>
        )}
        <Box
          aria-hidden="true"
          w={14}
          h={14}
          style={{ flex: 'none', display: 'grid', placeItems: 'center' }}
          onClick={
            showClose
              ? (event) => {
                  event.stopPropagation();
                  onClose();
                }
              : undefined
          }
        >
          {showClose ? <IconX size={12} stroke={1.5} /> : <Mark mark={info.words.mark} />}
        </Box>
      </div>
    </Tooltip>
  );
}
