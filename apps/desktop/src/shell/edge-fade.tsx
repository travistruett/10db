import { Box } from '@mantine/core';

export type FadeSide = 'top' | 'bottom' | 'left' | 'right';

export interface EdgeFadeProps {
  readonly side: FadeSide;
  readonly shown: boolean;
  /** The surface behind the scroll area, which the content fades into. */
  readonly color: string;
  /** How deep the fade reaches into the content, in pixels. */
  readonly depth: number;
  /** Where the fade's far edges stop: for a side fade, its top and bottom; for an end fade, its left and right. */
  readonly inset?: { readonly start?: number; readonly end?: number };
}

/**
 * A fade laid over one edge of a scroll area while content is hidden past it, so the area says there
 * is more without a scrollbar on screen. It stays mounted and eases its opacity, so it settles in
 * rather than snapping.
 */
export function EdgeFade({ side, shown, color, depth, inset = {} }: EdgeFadeProps) {
  const across =
    side === 'left' || side === 'right'
      ? { top: inset.start ?? 0, bottom: inset.end ?? 0, width: depth }
      : { left: inset.start ?? 0, right: inset.end ?? 0, height: depth };
  return (
    <Box
      aria-hidden="true"
      data-fade={side}
      pos="absolute"
      style={{
        ...across,
        [side]: 0,
        pointerEvents: 'none',
        opacity: shown ? 1 : 0,
        transition: 'opacity 200ms ease',
        background: `linear-gradient(to ${side}, transparent, ${color})`,
      }}
    />
  );
}
