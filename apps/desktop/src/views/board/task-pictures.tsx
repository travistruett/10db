import { ScreenKind, ScreenTheme, type TaskId, type TaskScreenDto } from '@10db/contracts';
import { Group, Stack, Text } from '@mantine/core';
import { useTaskScreens } from '../../daemon/screen-queries';
import { ScreenPicture } from '../workbench/turn-pictures';

// Workbench spec §10 "Where they show": in a task's drawer, each page's before beside its after, per
// route, viewport and theme. A task that takes no pictures shows nothing.

interface Pair {
  readonly key: string;
  readonly label: string;
  readonly before: TaskScreenDto | null;
  readonly after: TaskScreenDto | null;
}

const keyOf = (s: TaskScreenDto): string =>
  `${s.route} ${String(s.viewport.width)}x${String(s.viewport.height)} ${s.theme}`;

const labelOf = (s: TaskScreenDto): string =>
  [
    s.route,
    `${String(s.viewport.width)} by ${String(s.viewport.height)}`,
    ...(s.theme === ScreenTheme.Default ? [] : [`${s.theme} theme`]),
  ].join(', ');

/** The first before and the last after of each route, viewport and theme, in the order first taken. */
function pairsOf(screens: readonly TaskScreenDto[]): Pair[] {
  const pairs = new Map<string, Pair>();
  for (const s of screens) {
    if (s.kind === ScreenKind.Turn) continue;
    const key = keyOf(s);
    const pair = pairs.get(key) ?? { key, label: labelOf(s), before: null, after: null };
    pairs.set(
      key,
      s.kind === ScreenKind.Before ? { ...pair, before: pair.before ?? s } : { ...pair, after: s },
    );
  }
  return [...pairs.values()];
}

export function TaskPictures({ taskId }: { readonly taskId: TaskId }) {
  const screens = useTaskScreens(taskId).data?.screens ?? [];
  const pairs = pairsOf(screens);
  if (pairs.length === 0) return null;
  return (
    <Stack gap={4}>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">
        Pictures
      </Text>
      {pairs.map((pair) => (
        <Stack key={pair.key} gap={4} role="group" aria-label={pair.label}>
          <Text size="xs" c="dimmed">
            {pair.label}
          </Text>
          <Group gap="xs" align="flex-start" wrap="nowrap">
            {pair.before === null ? (
              <Text size="xs" c="dimmed" w={180}>
                No before picture
              </Text>
            ) : (
              <ScreenPicture screen={pair.before} name={pair.before.route} width={180} />
            )}
            {pair.after === null ? (
              <Text size="xs" c="dimmed" w={180}>
                No after picture yet
              </Text>
            ) : (
              <ScreenPicture screen={pair.after} name={pair.after.route} width={180} />
            )}
          </Group>
        </Stack>
      ))}
    </Stack>
  );
}
