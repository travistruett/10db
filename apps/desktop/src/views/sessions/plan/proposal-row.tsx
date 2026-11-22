import {
  ShapeProposalState,
  type ProjectId,
  type ShapeFindingId,
  type ShapeProposalDto,
  type ShapeTaskSizeDto,
} from '@10db/contracts';
import { ActionIcon, Anchor, Box, Collapse, Group, Menu, Stack, Text } from '@mantine/core';
import { IconDots, IconPencil } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { RowChange } from '../../../daemon/shape-queries';
import { useSelectedProject } from '../../../shell/selected-project';
import { RowAttachments } from './attachments/row-attachments';
import {
  convertedLine,
  kindChip,
  markText,
  proposalTitle,
  rowChipMeta,
  rowDot,
} from './proposal-text';
import type { RowReview } from './review-lines';
import { ReviewNotes } from './review-notes';
import { RowChips } from './row-chips';
import { RowLine, moveRowFocus, type OpenRow } from './row-line';
import { goalLiveLine } from './live-state';
import { RowDetails } from './row-details';
import { RowEditor } from './row-editor';
import { useLiveWords } from './use-live-words';
import { hoursText } from './preview-text';
import { goalHours } from './size-line';
import classes from './plan-rows.module.css';
import { editableFields } from './row-editing';

export interface RowAction {
  readonly label: string;
  readonly onSelect: () => void;
}

/** What the builder can do to a row: change it, or ask where it came from. */
export interface RowHandlers {
  readonly onChange: (row: ShapeProposalDto, change: RowChange) => void;
  /** Scrolls the conversation to the messages the row came from and highlights them. */
  readonly onWhy: (row: ShapeProposalDto) => void;
  /** Dismisses a reviewer's finding or a rehearsal question under a row (spec §7). */
  readonly onDismiss: (id: ShapeFindingId) => void;
}

export interface ProposalRowProps {
  /** The Plan's project: its accepted rows read their tasks' live state from it. */
  readonly projectId: ProjectId;
  readonly row: ShapeProposalDto;
  /** A goal's head, which opens above its tasks in its section, instead of a row of a list. */
  readonly head?: boolean;
  /** The section the row opens, so a summary count can jump to the first row of it. */
  readonly section: string;
  /** The one row the Tab key reaches; the arrows move between the rest. */
  readonly tabbable: boolean;
  /** The row's tasks' derived sizes: one for a loose task, one per sized task of a goal. */
  readonly sizes: readonly ShapeTaskSizeDto[];
  /** Extra menu items, such as the undos of a converted row. */
  readonly actions: readonly RowAction[];
  /** The ceremony, findings and rehearsal questions of a pending goal or task (spec §7). */
  readonly review?: RowReview | undefined;
  readonly handlers: RowHandlers;
  /** The panel's one open row; this row is open when it is its. */
  readonly open: OpenRow | null;
  readonly onOpenChange: (next: OpenRow | null) => void;
  /** The Plan's first round, where every row is new, so no row is marked New. */
  readonly firstRound?: boolean;
  /** Rows below the line, inside the same list item: a goal's tasks. */
  readonly children?: ReactNode;
}

/** A small dim link ending an opened row's line of facts. */
function MetaLink({
  onClick,
  children,
}: {
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <Anchor component="button" type="button" fz={12} underline="hover" onClick={onClick}>
      {children}
    </Anchor>
  );
}

/**
 * One row of a card: a line of title, facts and size over a region, as Factory's goal rows are, so a
 * click or Enter opens it in place, and only one row of the panel is open at a time. A pending row edits
 * in place (a pencil, or E); an edit pins it. P pins or unpins the row and W asks why. Its pencil and
 * menu take the facts' place on hover or focus.
 */
export function ProposalRow({
  projectId,
  row,
  head = false,
  section,
  tabbable,
  sizes,
  actions,
  review,
  handlers,
  open,
  onOpenChange,
  firstRound = false,
  children,
}: ProposalRowProps) {
  const opened = open?.id === row.id;
  const editing = opened && open.editing;
  const button = useRef<HTMLButtonElement>(null);
  const title = proposalTitle(row);
  const live = useLiveWords(row, projectId);
  const { select } = useSelectedProject();
  const converted = convertedLine(
    row,
    live === null
      ? undefined
      : row.kind === 'goal'
        ? goalLiveLine(live.words)
        : (live.words[0]?.word ?? ''),
  );
  const dot = rowDot(row);
  const mark = markText(row);
  const openTask =
    live === null || row.converted === null
      ? null
      : row.kind === 'task'
        ? (row.converted.taskIds[0] ?? null)
        : (row.converted.taskIds.find((_, i) => {
            const task = live.tasks[i];
            return task !== undefined && task.status !== 'cancelled' && task.boardStatus !== 'done';
          }) ?? null);
  const openGoal = row.kind === 'goal' ? (row.converted?.goalId ?? null) : null;
  const regionId = `shape-row-${row.id}`;
  const pinned = row.pinned.length > 0;
  const mutable =
    row.state === ShapeProposalState.Pending || row.state === ShapeProposalState.Superseded;
  const canEdit = mutable && editableFields(row).length > 0;
  const earlier = row.state === ShapeProposalState.Superseded;

  const change = (c: RowChange): void => {
    handlers.onChange(row, c);
  };
  const togglePin = (): void => {
    change(pinned ? { kind: 'unpin' } : { kind: 'restore' });
  };
  const startEditing = (): void => {
    onOpenChange({ id: row.id, editing: true });
  };
  const stopEditing = (): void => {
    onOpenChange({ id: row.id, editing: false });
    button.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : null;
    if (delta !== null) {
      if (moveRowFocus(event.currentTarget, delta)) event.preventDefault();
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'w') handlers.onWhy(row);
    else if (key === 'p' && mutable) togglePin();
    else if (key === 'e' && canEdit) startEditing();
    else return;
    event.preventDefault();
  };

  const menu: RowAction[] = [
    ...(canEdit ? [{ label: 'Edit', onSelect: startEditing }] : []),
    ...(earlier
      ? [
          {
            label: 'Restore',
            onSelect: () => {
              change({ kind: 'restore' });
            },
          },
        ]
      : []),
    ...(mutable && !earlier
      ? [
          {
            label: pinned ? 'Let the Agent Change It' : 'Keep My Version',
            onSelect: togglePin,
          },
        ]
      : []),
    {
      label: 'Show in Conversation',
      onSelect: () => {
        handlers.onWhy(row);
      },
    },
    ...(mutable
      ? [
          {
            label: 'Remove from Plan',
            onSelect: () => {
              change({ kind: 'drop' });
            },
          },
        ]
      : []),
    ...actions,
  ];

  const findings = review?.findings ?? [];
  const questions = review?.tasks.flatMap((t) => t.questions) ?? [];
  // A goal's questions belong to its tasks, which show them; a loose task is its own single task.
  const ownQuestions = row.kind === 'goal' ? [] : questions;
  const lane = row.kind === 'goal' ? goalHours(sizes) : null;
  const trailing =
    row.kind === 'goal'
      ? (lane ?? undefined)
      : row.kind === 'task'
        ? sizes[0] === undefined
          ? row.body.size
          : `~${hoursText(sizes[0].hours)}`
        : rowChipMeta(row);
  const ceremony = review?.ceremony;
  const spec = ceremony?.ceremony === 'spec' && !ceremony.skippedByYou;

  const subs: ReactNode[] = [];
  if (row.kind === 'goal')
    subs.push(
      <Text key="objective" fz={13} c="dimmed" {...(opened ? {} : { lineClamp: 2 })}>
        {row.body.objective}
      </Text>,
    );
  if (converted !== null)
    subs.push(
      <Text key="converted" fz={12} c="dimmed">
        {converted}
      </Text>,
    );
  if (openTask !== null || openGoal !== null)
    subs.push(
      <Anchor
        key="board"
        fz={12}
        className={classes['lift']}
        renderRoot={(props) =>
          openTask === null ? (
            <Link {...props} to="/factory" search={{ goal: openGoal ?? undefined }} />
          ) : (
            <Link {...props} to="/board" search={{ task: openTask }} />
          )
        }
        onClick={() => {
          select(projectId);
        }}
      >
        Open on Board
      </Anchor>,
    );

  const controls = (
    <Group gap={2} wrap="nowrap">
      {canEdit ? (
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={`Edit ${title}`}
          onClick={startEditing}
        >
          <IconPencil size={16} stroke={1.5} />
        </ActionIcon>
      ) : null}
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            className={classes['menu']}
            aria-label={`Actions for ${title}`}
          >
            <IconDots size={16} stroke={1.5} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          {menu.map((action) => (
            <Menu.Item key={action.label} onClick={action.onSelect}>
              {action.label}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );

  const line = (
    <RowLine
      title={title}
      head={head}
      dim={converted !== null}
      subs={subs.length === 0 ? undefined : <Stack gap={0}>{subs}</Stack>}
      chips={
        <RowChips
          facts={{
            mark:
              mark === null || row.mark === null || firstRound
                ? null
                : { text: mark, kind: row.mark, dot: dot?.color ?? null },
            kind: kindChip(row),
            spec,
            notes: findings.length + ownQuestions.length,
            pinned,
          }}
        />
      }
      trailing={trailing}
      trailingLabel={
        row.kind === 'task' && sizes[0] !== undefined
          ? `About ${hoursText(sizes[0].hours)} of agent time`
          : undefined
      }
      section={section}
      opened={opened}
      regionId={regionId}
      tabbable={tabbable}
      buttonRef={button}
      onToggle={() => {
        onOpenChange(opened ? null : { id: row.id, editing: false });
      }}
      onKeyDown={onKeyDown}
    />
  );
  const region = (
    <Collapse expanded={opened} keepMounted={false} transitionDuration={150}>
      <Box id={regionId} role="region" aria-label={`${title} details`} px={12} pt={4} pb={16}>
        {editing ? (
          <RowEditor
            row={row}
            onCancel={stopEditing}
            onSave={(fields) => {
              change({ kind: 'edit', fields });
              stopEditing();
            }}
          />
        ) : (
          <RowDetails
            row={row}
            sizes={sizes}
            notes={
              review === undefined ? undefined : (
                <ReviewNotes
                  ceremony={review.ceremony}
                  findings={findings}
                  questions={ownQuestions}
                  settled={review.settled}
                  onDismiss={handlers.onDismiss}
                  onCeremony={(c) => {
                    change(
                      c === 'skip'
                        ? { kind: 'edit', fields: { ceremony: 'direct' } }
                        : { kind: 'unpin', field: 'ceremony' },
                    );
                  }}
                />
              )
            }
            links={[
              <MetaLink
                key="why"
                onClick={() => {
                  handlers.onWhy(row);
                }}
              >
                Show in Conversation
              </MetaLink>,
              ...(earlier
                ? [
                    <MetaLink
                      key="restore"
                      onClick={() => {
                        change({ kind: 'restore' });
                      }}
                    >
                      Restore
                    </MetaLink>,
                  ]
                : []),
            ]}
            attachments={<RowAttachments row={row} title={title} />}
            actions={controls}
          />
        )}
      </Box>
    </Collapse>
  );

  const wrap = { className: classes['item'], ...(opened ? { 'data-open': '' } : {}) };
  if (head)
    return (
      <>
        <div {...wrap}>
          {line}
          {region}
        </div>
        {children}
      </>
    );
  return (
    <li {...wrap} style={{ listStyle: 'none' }}>
      {line}
      {region}
      {children}
    </li>
  );
}
