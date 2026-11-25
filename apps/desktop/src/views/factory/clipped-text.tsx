import { Text, Tooltip, type MantineColor } from '@mantine/core';
import { useState, type MouseEvent } from 'react';

/**
 * One line of a task line, cut with an ellipsis when its column is too narrow. Only a cut line has a
 * tooltip, measured as the pointer enters, so the whole text is one hover away and an uncut one stays quiet.
 */
export function ClippedText({
  text,
  className,
  c,
  wide = false,
}: {
  readonly text: string;
  readonly className: string | undefined;
  readonly c?: MantineColor;
  /** Marks the state of a line with no step progress or model, which spans their columns. */
  readonly wide?: boolean;
}) {
  const [cut, setCut] = useState(false);
  return (
    <Tooltip
      label={text}
      disabled={!cut}
      openDelay={300}
      multiline
      maw={420}
      onMouseEnter={(event: MouseEvent<HTMLElement>) => {
        const el = event.currentTarget;
        setCut(el.scrollWidth > el.clientWidth);
      }}
    >
      <Text
        component="span"
        size="xs"
        {...(c === undefined ? {} : { c })}
        truncate
        className={className}
        data-wide={wide || undefined}
      >
        {text}
      </Text>
    </Tooltip>
  );
}
