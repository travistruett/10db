import type { AreaDef, PassStartPageDto, TaskId } from '@10db/contracts';
import { Checkbox, Stack, Text, TextInput } from '@mantine/core';
import { useId, useState, type ReactNode } from 'react';
import { shortAgo } from '../factory/short-ago';
import { blockedReason, type JoinableTask, type PickTicks } from './start-pass-rules';

export interface PagePickerProps {
  readonly pages: readonly PassStartPageDto[];
  readonly tasks: readonly JoinableTask[];
  readonly areas: readonly AreaDef[];
  readonly ticks: PickTicks;
  readonly onTicks: (ticks: PickTicks) => void;
  /** Now, in epoch milliseconds: when each page's files last changed is said from here. */
  readonly now: number;
}

/** "/settings · changed 1d ago", with what holds the page when something does. */
function pageLine(page: PassStartPageDto, now: number): string {
  const route = page.route ?? 'No route';
  const changed =
    page.lastChangedAt === null ? 'no changes yet' : `changed ${shortAgo(page.lastChangedAt, now)}`;
  return `${route} · ${changed}`;
}

const matches = (filter: string, ...texts: readonly (string | null)[]) =>
  filter === '' || texts.some((text) => text?.toLowerCase().includes(filter) === true);

function without<T>(list: readonly T[], drop: (item: T) => boolean): T[] {
  return list.filter((item) => !drop(item));
}

/** One ticked row's neighbours: the ticks with that row taken out, so it is never blocked by itself. */
function othersOf(ticks: PickTicks, row: { page?: string; taskId?: TaskId }): PickTicks {
  return {
    pages: without(ticks.pages, (page) => page === row.page),
    tasks: without(ticks.tasks, (task) => task.taskId === row.taskId),
  };
}

interface PickRowProps {
  readonly label: string;
  readonly line: string;
  readonly note: string | null;
  readonly checked: boolean;
  readonly blocked: string | null;
  readonly onChange: (checked: boolean) => void;
}

function PickRow({ label, line, note, checked, blocked, onChange }: PickRowProps) {
  return (
    <Checkbox
      label={label}
      checked={checked}
      disabled={!checked && blocked !== null}
      onChange={(event) => {
        onChange(event.currentTarget.checked);
      }}
      description={
        <Stack gap={0} component="span">
          <Text span size="xs" c="dimmed">
            {line}
          </Text>
          {note === null ? null : (
            <Text span size="xs" c="dimmed">
              {note}
            </Text>
          )}
          {checked || blocked === null ? null : (
            <Text span size="xs" c="dimmed">
              {blocked}
            </Text>
          )}
        </Stack>
      }
    />
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <Stack gap="xs" role="group" aria-labelledby={id}>
      <Text id={id} size="sm" fw={600}>
        {title}
      </Text>
      {children}
    </Stack>
  );
}

/**
 * The picker's rows (Workbench spec §4.2): every page area with its route and last change, then the
 * open Board tasks that could join. A row that would hold a file a ticked row holds is disabled and
 * says why.
 */
export function PagePicker({ pages, tasks, areas, ticks, onTicks, now }: PagePickerProps) {
  const [filter, setFilter] = useState('');
  const wanted = filter.trim().toLowerCase();
  const shownPages = pages.filter(
    (page) => ticks.pages.includes(page.area) || matches(wanted, page.area, page.route),
  );
  const ticked = (taskId: TaskId) => ticks.tasks.some((task) => task.taskId === taskId);
  const shownTasks = tasks.filter(
    (task) => ticked(task.taskId) || matches(wanted, task.title, ...task.pages),
  );
  return (
    <Stack gap="md">
      <TextInput
        aria-label="Filter pages and tasks"
        placeholder="Filter"
        value={filter}
        onChange={(event) => {
          setFilter(event.currentTarget.value);
        }}
      />
      <Section title="Pages">
        {shownPages.map((page) => {
          const checked = ticks.pages.includes(page.area);
          return (
            <PickRow
              key={page.area}
              label={page.area}
              line={pageLine(page, now)}
              note={page.heldBy === null ? null : `Waits for ${page.heldBy.title}`}
              checked={checked}
              blocked={blockedReason({ pages: [page.area] }, ticks, areas)}
              onChange={(on) => {
                const others = othersOf(ticks, { page: page.area });
                onTicks(on ? { ...others, pages: [...others.pages, page.area] } : others);
              }}
            />
          );
        })}
        {shownPages.length === 0 ? (
          <Text size="sm" c="dimmed">
            No page matches.
          </Text>
        ) : null}
      </Section>
      {tasks.length === 0 ? null : (
        <Section title="Open UI tasks">
          {shownTasks.map((task) => (
            <PickRow
              key={task.taskId}
              label={task.title}
              line={task.pages.join(', ')}
              note={null}
              checked={ticked(task.taskId)}
              blocked={blockedReason(task, ticks, areas)}
              onChange={(on) => {
                const others = othersOf(ticks, { taskId: task.taskId });
                onTicks(on ? { ...others, tasks: [...others.tasks, task] } : others);
              }}
            />
          ))}
        </Section>
      )}
    </Stack>
  );
}
