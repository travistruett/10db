import type { ScreenMessageBody } from '@10db/contracts';
import { Text } from '@mantine/core';
import { useShapeScreen } from '../../daemon/shape-queries';
import { SCREEN_LABEL } from '../../screens/draw-screen';
import { useRenderMode } from '../../screens/render-context';

interface ScreenshotProps {
  readonly shapeId: Parameters<typeof useShapeScreen>[0];
  readonly screen: ScreenMessageBody;
}

const inSentence = (label: string): string => label.replace(/^The /, 'the ');

/**
 * A screenshot Plan took with `see_screen`, as the builder sees it in the conversation (Shape spec §5.5).
 * A Plan screen drawn for Plan shows a line in its place: the render token reads no kept picture, and
 * pictures inside a picture would only spend what one picture may hold.
 */
export function Screenshot(props: ScreenshotProps) {
  const { screen } = props;
  if (useRenderMode() === null) return <KeptScreenshot {...props} />;
  return (
    <Text size="xs" c="dimmed">
      A screenshot of {inSentence(SCREEN_LABEL[screen.screen])} at {String(screen.width)}×
      {String(screen.height)}.
    </Text>
  );
}

function KeptScreenshot({ shapeId, screen }: ScreenshotProps) {
  const image = useShapeScreen(shapeId, screen.name);
  const label = SCREEN_LABEL[screen.screen];
  const size = `${String(screen.width)}×${String(screen.height)}`;
  if (image.isError)
    return (
      <Text size="xs" c="dimmed">
        The screenshot of {inSentence(label)} can no longer be shown.
      </Text>
    );
  if (image.data === undefined)
    return (
      <Text size="xs" c="dimmed">
        Loading the screenshot…
      </Text>
    );
  return (
    <img
      src={image.data}
      alt={`${label} at ${size}, as Plan saw it`}
      width={screen.width}
      height={screen.height}
      style={{
        display: 'block',
        maxWidth: '100%',
        height: 'auto',
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-sm)',
      }}
    />
  );
}
