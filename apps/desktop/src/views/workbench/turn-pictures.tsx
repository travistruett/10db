import type { TaskScreenDto } from '@10db/contracts';
import { Group, Text } from '@mantine/core';
import { useScreenPicture } from '../../daemon/screen-queries';
import { screenAlt } from './screen-alt';

// Workbench spec §4.3, §10: pictures of the builder's app in a page's thread: the before at the top,
// and each turn's under its reply. They stay on the Mac; the UI reads them by id with its token.

/** One picture, read with the UI token; its alt text says the page, when, and the window. */
export function ScreenPicture({
  screen,
  name,
  width = 320,
}: {
  readonly screen: TaskScreenDto;
  readonly name: string;
  readonly width?: number;
}) {
  const image = useScreenPicture(screen.id);
  const alt = screenAlt(name, screen);
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
