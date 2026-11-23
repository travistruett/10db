import type { AreaDef, PassStartPageDto } from '@10db/contracts';
import type { TaskId } from '@10db/contracts';
import {
  ActionIcon,
  Checkbox,
  Divider,
  Group,
  Menu,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { Fragment, useState, type ReactNode } from 'react';
import { useRemoveTask } from '../../daemon/queries';
import { ConfirmModal } from '../../shell/confirm-modal';
import {
  blockedReason,
  changedLine,
  othersOf,
  pageLabelIn,
  type JoinableTask,
  type PickTicks,
} from './start-pass-rules';

export interface PageListProps {
  readonly pages: readonly PassStartPageDto[];
  readonly tasks: readonly JoinableTask[];
  readonly areas: readonly AreaDef[];
  readonly ticks: PickTicks;
  readonly onTicks: (ticks: PickTicks) => void;
  /** Now, in epoch milliseconds: when each page's files last changed is said from here. */
  readonly now: number;
}

/** One tickable row: its words on the line, and what holds it or why it cannot join under them. */
function TickRow({
  label,
  checked,
  disabled,
  onChange,
  detail,
  aside,
  notes,
  menu,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly detail?: string | null;
  readonly aside: string;
  readonly notes: readonly string[];
  /** The row's own actions, after its aside. */
  readonly menu?: ReactNode;
}) {
  return (
    <Stack gap={0} px="md" py={8}>
      <Group justify="space-between" gap="sm" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Checkbox
            label={label}
            checked={checked}
            disabled={disabled}
            onChange={(event) => {
              onChange(event.currentTarget.checked);
            }}
          />
          {detail === undefined ? null : (
            <Text size="xs" c="dimmed" ff="monospace" truncate>
              {detail ?? 'No route'}
            </Text>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
          <Text size="xs" c="dimmed">
            {aside}
          </Text>
          {menu}
        </Group>
      </Group>
      {notes.map((note) => (
        <Text key={note} size="xs" c="dimmed" pl={28}>
          {note}
        </Text>
      ))}
    </Stack>
  );
}

/** A titled list on the start page: a heading with its count and one dimmed line, then the rows in a card. */
function TickSection({
  title,
  line,
  count,
  children,
}: {
  readonly title: string;
  readonly line: string;
  readonly count: number;
  readonly children: readonly ReactNode[];
}) {
  return (
    <Stack gap="xs" role="group" aria-label={title}>
      <Stack gap={2}>
        <Group gap="xs" align="baseline">
          <Title order={4}>{title}</Title>
          <Text size="sm" c="dimmed">
            {count}
          </Text>
        </Group>
        <Text size="sm" c="dimmed">
          {line}
        </Text>
      </Stack>
      <Paper withBorder radius="md">
        {children.map((row, i) => (
          <Fragment key={i}>
            {i > 0 ? <Divider /> : null}
            {row}
          </Fragment>
        ))}
      </Paper>
    </Stack>
  );
}

/** An open UI task's menu: open it on the Board, or remove it (it has not run). */
function TaskMenu({ taskId, title }: { readonly taskId: TaskId; readonly title: string }) {
  const navigate = useNavigate();
  const remove = useRemoveTask();
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Menu position="bottom-end">
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`${title} options`}>
            <IconDots size={14} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            onClick={() => {
              void navigate({ to: '/board', search: { task: taskId } });
            }}
          >
            Open on Board
          </Menu.Item>
          <Menu.Item
            color="red"
            onClick={() => {
              remove.reset();
              setAsking(true);
            }}
          >
            Remove Task
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <ConfirmModal
        opened={asking}
        title="Remove Task"
        confirmLabel="Remove Task"
        destructive
        loading={remove.isPending}
        error={remove.isError ? remove.error.message : null}
        onCancel={() => {
          setAsking(false);
        }}
        onConfirm={() => {
          remove.mutate(taskId, {
            onSuccess: () => {
              setAsking(false);
            },
          });
        }}
      >
        {`Remove "${title}"? It has not run, so nothing else is lost; it leaves the Board.`}
      </ConfirmModal>
    </>
  );
}

/**
 * The project's pages as rows to tick, then the open UI tasks that can join (Workbench spec §4.2). A
 * row that would hold a file a ticked row holds is disabled and says why, by the same rule the search
 * picker uses (`blockedReason`).
 */
export function PageList({ pages, tasks, areas, ticks, onTicks, now }: PageListProps) {
  return (
    <Stack gap="xl">
      <TickSection title="Pages" line="Tick the pages to work through." count={pages.length}>
        {pages.map((page) => {
          const checked = ticks.pages.includes(page.area);
          const blocked = checked ? null : blockedReason({ pages: [page.area] }, ticks, areas);
          return (
            <TickRow
              key={page.area}
              label={page.label}
              checked={checked}
              disabled={blocked !== null}
              detail={page.route}
              aside={changedLine(page, now)}
              notes={[
                ...(page.heldBy === null ? [] : [`Waits for ${page.heldBy.title}`]),
                ...(blocked === null ? [] : [blocked]),
              ]}
              onChange={(on) => {
                onTicks({
                  ...ticks,
                  pages: on
                    ? [...ticks.pages, page.area]
                    : ticks.pages.filter((name) => name !== page.area),
                });
              }}
            />
          );
        })}
      </TickSection>
      {tasks.length === 0 ? null : (
        <TickSection
          title="Open UI Tasks"
          line="Board tasks that change a page. Tick one to work on it here."
          count={tasks.length}
        >
          {tasks.map((task) => {
            const checked = ticks.tasks.some((t) => t.taskId === task.taskId);
            const blocked = checked
              ? null
              : blockedReason(task, othersOf(ticks, { taskId: task.taskId }), areas);
            return (
              <TickRow
                key={task.taskId}
                label={task.title}
                checked={checked}
                disabled={blocked !== null}
                aside={task.pages.map((name) => pageLabelIn(areas, name)).join(', ')}
                notes={blocked === null ? [] : [blocked]}
                menu={<TaskMenu taskId={task.taskId} title={task.title} />}
                onChange={(on) => {
                  onTicks({
                    ...ticks,
                    tasks: on
                      ? [...ticks.tasks, task]
                      : ticks.tasks.filter((t) => t.taskId !== task.taskId),
                  });
                }}
              />
            );
          })}
        </TickSection>
      )}
    </Stack>
  );
}
