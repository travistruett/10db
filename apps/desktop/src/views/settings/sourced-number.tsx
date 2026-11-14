import { Tooltip, VisuallyHidden } from '@mantine/core';
import { useId } from 'react';

/**
 * A figure that says where it came from: the words show on hover, and a screen reader hears them with the number.
 * The text is not made focusable for its tooltip. With no source it is the text alone.
 */
export function SourcedNumber({
  text,
  source,
}: {
  readonly text: string;
  readonly source: string | null;
}) {
  const id = useId();
  if (source === null) return <span>{text}</span>;
  return (
    <>
      <Tooltip label={source} openDelay={300} withArrow>
        <span aria-describedby={id}>{text}</span>
      </Tooltip>
      <VisuallyHidden id={id}>{source}</VisuallyHidden>
    </>
  );
}
