import type { AreaDef, PassStartPageDto } from '@10db/contracts';
import { Checkbox, Group, Stack, Text } from '@mantine/core';
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
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly detail?: string | null;
  readonly aside: string;
  readonly notes: readonly string[];
}) {
  return (
    <Stack gap={0}>
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
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          {aside}
        </Text>
      </Group>
      {notes.map((note) => (
        <Text key={note} size="xs" c="dimmed" pl={28}>
          {note}
        </Text>
      ))}
    </Stack>
  );
}

/**
 * The project's pages as rows to tick, then the open UI tasks that can join (Workbench spec §4.2). A
 * row that would hold a file a ticked row holds is disabled and says why, by the same rule the search
 * picker uses (`blockedReason`).
 */
export function PageList({ pages, tasks, areas, ticks, onTicks, now }: PageListProps) {
  return (
    <Stack gap="sm">
      <Stack gap="xs" role="group" aria-label="Pages">
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
      </Stack>
      {tasks.length === 0 ? null : (
        <Stack gap="xs" role="group" aria-label="Open UI Tasks">
          <Text size="sm" fw={600}>
            Open UI Tasks
          </Text>
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
        </Stack>
      )}
    </Stack>
  );
}
