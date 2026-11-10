import type { TaskScreenDto } from '@10db/contracts';
import { Group, Stack, Text } from '@mantine/core';
import { useScreenPicture } from '../../daemon/screen-queries';
import { screenAlt } from './screen-alt';

// Workbench spec §4.2, §4.3, §10: pictures of the builder's app in a page's thread: the goal's earlier
// pictures of the page and the before at the top, and each turn's under its reply. They stay on the Mac; the UI reads them by id with its token.

/** One picture, read with the UI token; its alt text says the page, when, and the window. */
export function ScreenPicture({
  screen,
  name,
  width = 320,
  fromGoal = false,
}: {
  readonly screen: TaskScreenDto;
  readonly name: string;
  readonly width?: number;
  /** Taken for another task of the goal this page's task is in. */
  readonly fromGoal?: boolean;
}) {
  const image = useScreenPicture(screen.id);
  const alt = screenAlt(name, screen, fromGoal);
  if (image.isError)
    return (
      <Text size="xs" c="dimmed">
        {alt} can no longer be shown.
      </Text>
    );
  if (image.data === undefined)
    return (
      <Text size="xs" c="dimmed">
        Loading {alt}…
      </Text>
    );
  return (
    <img
      src={image.data}
      alt={alt}
      title={alt}
      style={{
        display: 'block',
        width,
        maxWidth: '100%',
        height: 'auto',
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-sm)',
      }}
    />
  );
}

/** A row of pictures; nothing when there are none. */
export function TurnPictures({
  screens,
  name,
}: {
  readonly screens: readonly TaskScreenDto[];
  readonly name: string;
}) {
  if (screens.length === 0) return null;
  return (
    <Group gap="xs" align="flex-start" wrap="wrap" mt={4}>
      {screens.map((screen) => (
        <ScreenPicture key={screen.id} screen={screen} name={name} />
      ))}
    </Group>
  );
}

/**
 * The pictures a goal's earlier tasks kept of this page, then the page's own before (spec §4.2, P8):
 * nothing when there are neither.
 */
export function OpeningPictures({
  fromGoal,
  befores,
  name,
}: {
  readonly fromGoal: readonly TaskScreenDto[];
  readonly befores: readonly TaskScreenDto[];
  readonly name: string;
}) {
  if (fromGoal.length === 0) return <TurnPictures screens={befores} name={name} />;
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        Earlier in this goal
      </Text>
      <Group gap="xs" align="flex-start" wrap="wrap">
        {fromGoal.map((screen) => (
          <ScreenPicture key={screen.id} screen={screen} name={name} fromGoal />
        ))}
        {befores.map((screen) => (
          <ScreenPicture key={screen.id} screen={screen} name={name} />
        ))}
      </Group>
    </Stack>
  );
}
