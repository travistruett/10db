import { SizeSource, type ShapeTaskSizeDto } from '@10db/contracts';

// Shape spec §8 Calibration, shown: a proposed task's derived size and hours, and once it is
// converted and finished, the lane time it took.

/** Hours as the sidebar writes them: at most one decimal, no trailing zero. */
function hoursText(hours: number): string {
  return String(Math.round(hours * 10) / 10);
}

export interface SizeLine {
  readonly text: string;
  /** The actual is more than one bucket from the size: the row shows a clock-exclamation icon. */
  readonly flagged: boolean;
}

export function sizeLine(size: ShapeTaskSizeDto): SizeLine {
  const parts = [`Sized ${size.size} (~${hoursText(size.hours)} h)`];
  if (size.from === SizeSource.Pinned) parts.push('size set by you');
  if (size.actualHours !== null) parts.push(`took ${hoursText(size.actualHours)} h of lane time`);
  return { text: parts.join(' · '), flagged: size.missized };
}

/** A goal's lane time is its tasks' sum, as "~1 h"; null when none of them is sized yet. */
export function goalHours(sizes: readonly ShapeTaskSizeDto[]): string | null {
  if (sizes.length === 0) return null;
  return `~${hoursText(sizes.reduce((sum, s) => sum + s.hours, 0))} h`;
}

/**
 * What an opened task says about its size, once: "Area: repo · about 0.5 h of agent time", then "size
 * set by you" and, when it has finished, the lane time it took.
 */
export function sizeFacts(areas: readonly string[], size: ShapeTaskSizeDto | undefined): string {
  const parts =
    areas.length === 0 ? [] : [`${areas.length === 1 ? 'Area' : 'Areas'}: ${areas.join(', ')}`];
  if (size !== undefined) {
    parts.push(`about ${hoursText(size.hours)} h of agent time`);
    if (size.from === SizeSource.Pinned) parts.push('size set by you');
    if (size.actualHours !== null) parts.push(`took ${hoursText(size.actualHours)} h of lane time`);
  }
  return parts.join(' · ');
}
