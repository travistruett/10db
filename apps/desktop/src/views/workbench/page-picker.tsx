import type { AreaDef, PassStartPageDto, TaskId } from '@10db/contracts';
import {
  Box,
  Group,
  MultiSelect,
  Pill,
  Stack,
  Text,
  type ComboboxItem,
  type ComboboxItemGroup,
  type ComboboxParsedItem,
  type OptionsFilter,
} from '@mantine/core';
import { IconCheck, IconSubtask } from '@tabler/icons-react';
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
  /** The pages an open pass holds already, for Add Page: not offered, and nothing may share their files. */
  readonly inPass?: readonly string[];
}

/** What one option says beyond its name, and the text a search matches. */
interface Choice {
  readonly name: string;
  readonly route: string | null;
  readonly kind: 'page' | 'task';
  /** Right of the name: when the page last changed, or the pages a task works on. */
  readonly aside: string;
  /** Under the name: what holds the page, or why it can't join what is picked. */
  readonly notes: readonly string[];
  readonly haystack: string;
}

const PAGE = 'page:';
const pageValue = (area: string) => `${PAGE}${area}`;
const taskValue = (taskId: TaskId) => `task:${taskId}`;

function without<T>(list: readonly T[], drop: (item: T) => boolean): T[] {
  return list.filter((item) => !drop(item));
}

/** The picked rows with one row taken out, so a row is never blocked by itself. */
function othersOf(ticks: PickTicks, row: { page?: string; taskId?: TaskId }): PickTicks {
  return {
    pages: without(ticks.pages, (page) => page === row.page),
    tasks: without(ticks.tasks, (task) => task.taskId === row.taskId),
  };
}

const changedLine = (page: PassStartPageDto, now: number) =>
  page.lastChangedAt === null ? 'no changes yet' : `changed ${shortAgo(page.lastChangedAt, now)}`;

/** Keeps the options whose name, route or pages hold the search, inside their groups. */
function filterBy(choices: ReadonlyMap<string, Choice>): OptionsFilter {
  return ({ options, search }) => {
    const wanted = search.trim().toLowerCase();
    if (wanted === '') return options;
    const hit = (item: ComboboxItem) => choices.get(item.value)?.haystack.includes(wanted) === true;
    return options.flatMap((option): ComboboxParsedItem[] => {
      if ('group' in option) {
        const items = option.items.filter(hit);
        return items.length === 0 ? [] : [{ group: option.group, items }];
      }
      return hit(option) ? [option] : [];
    });
  };
}

/**
 * One option: name, route and last change, with what holds it under them. A picked one is checked
 * on the right, as DESIGN.md has every multi-select do; drawing the option replaces Mantine's own.
 */
function OptionBody({ choice, checked }: { readonly choice: Choice; readonly checked: boolean }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start" style={{ flex: 1, minWidth: 0 }}>
      <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
        <Group justify="space-between" gap="sm" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <Text size="sm" truncate>
              {choice.name}
            </Text>
            {choice.kind === 'page' ? (
              <Text size="xs" c="dimmed" ff="monospace">
                {choice.route ?? 'No route'}
              </Text>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
            {choice.aside}
          </Text>
        </Group>
        {choice.notes.map((note) => (
          <Text key={note} size="xs" c="dimmed">
            {note}
          </Text>
        ))}
      </Stack>
      {checked ? (
        <IconCheck
          size={16}
          stroke={1.5}
          aria-label="Picked"
          style={{ flex: 'none', marginTop: 2 }}
        />
      ) : (
        // Keeps the options' right edges in line whether or not they are picked.
        <Box w={16} style={{ flex: 'none' }} />
      )}
    </Group>
  );
}

function PickedPill({
  choice,
  fallback,
  onRemove,
}: {
  readonly choice: Choice | undefined;
  readonly fallback: string;
  readonly onRemove: (() => void) | undefined;
}) {
  const name = choice?.name ?? fallback;
  return (
    <Pill
      withRemoveButton
      {...(onRemove ? { onRemove } : {})}
      removeButtonProps={{ 'aria-label': `Remove ${name}` }}
    >
      <Group gap={6} wrap="nowrap" component="span">
        {choice?.kind === 'task' ? <IconSubtask size={14} stroke={1.5} aria-hidden /> : null}
        <span>{name}</span>
        {choice?.route == null ? null : (
          <Text span size="xs" c="dimmed" ff="monospace">
            {choice.route}
          </Text>
        )}
      </Group>
    </Pill>
  );
}

/**
 * The pages and open UI tasks a pass can start with (Workbench spec §4.2), as one search whose pills
 * are what is picked. Each option shows its route and last change; one that would hold a file a
 * picked row holds is disabled and says why.
 */
export function PagePicker(props: PagePickerProps) {
  const { pages, tasks, areas, ticks, onTicks, now, inPass = [] } = props;
  const choices = new Map<string, Choice>();
  const pageItems: ComboboxItem[] = pages
    .filter((page) => !inPass.includes(page.area))
    .map((page) => {
      const value = pageValue(page.area);
      const blocked = ticks.pages.includes(page.area)
        ? null
        : blockedReason({ pages: [page.area] }, ticks, areas, inPass);
      choices.set(value, {
        name: page.area,
        route: page.route,
        kind: 'page',
        aside: changedLine(page, now),
        notes: [
          ...(page.heldBy === null ? [] : [`Waits for ${page.heldBy.title}`]),
          ...(blocked === null ? [] : [blocked]),
        ],
        haystack: [page.area, page.route ?? ''].join(' ').toLowerCase(),
      });
      return { value, label: page.area, disabled: blocked !== null };
    });
  const taskItems: ComboboxItem[] = tasks.map((task) => {
    const value = taskValue(task.taskId);
    const blocked = ticks.tasks.some((t) => t.taskId === task.taskId)
      ? null
      : blockedReason(task, othersOf(ticks, { taskId: task.taskId }), areas, inPass);
    choices.set(value, {
      name: task.title,
      route: null,
      kind: 'task',
      aside: task.pages.join(', '),
      notes: blocked === null ? [] : [blocked],
      haystack: [task.title, ...task.pages].join(' ').toLowerCase(),
    });
    return { value, label: task.title, disabled: blocked !== null };
  });
  const data: (ComboboxItem | ComboboxItemGroup<ComboboxItem>)[] =
    taskItems.length === 0
      ? pageItems
      : [
          { group: 'Pages', items: pageItems },
          { group: 'Open UI tasks', items: taskItems },
        ];
  const value = [
    ...ticks.pages.map(pageValue),
    ...ticks.tasks.map((task) => taskValue(task.taskId)),
  ];
  return (
    <MultiSelect
      label="Pages"
      placeholder={tasks.length === 0 ? 'Search pages' : 'Search pages and open UI tasks'}
      data={data}
      value={value}
      onChange={(next) => {
        onTicks({
          pages: next.flatMap((v) => (v.startsWith(PAGE) ? [v.slice(PAGE.length)] : [])),
          tasks: tasks.filter((task) => next.includes(taskValue(task.taskId))),
        });
      }}
      searchable
      filter={filterBy(choices)}
      nothingFoundMessage="No page matches."
      maxDropdownHeight={360}
      renderOption={({ option, checked }) => {
        const choice = choices.get(option.value);
        return choice ? <OptionBody choice={choice} checked={checked === true} /> : option.label;
      }}
      renderPill={({ option, onRemove }) => (
        <PickedPill
          choice={choices.get(String(option.value))}
          fallback={option.label}
          onRemove={onRemove}
        />
      )}
    />
  );
}
