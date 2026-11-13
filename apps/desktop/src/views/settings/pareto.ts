/** A model at an effort, placed by what a task costs on it and how intelligent it is. */
export interface ParetoPoint {
  readonly model: string;
  readonly effort: string;
  readonly cost: number;
  readonly intelligence: number;
}

/**
 * The points no other point beats: none other costs no more and scores at least as much, with one of the two
 * strictly. They come back cheapest first. Of points tied on both, the first by model and effort stays.
 */
export function paretoFrontier<T extends ParetoPoint>(points: readonly T[]): T[] {
  const ordered = [...points].sort(
    (a, b) =>
      a.cost - b.cost ||
      b.intelligence - a.intelligence ||
      a.model.localeCompare(b.model) ||
      a.effort.localeCompare(b.effort),
  );
  const frontier: T[] = [];
  let best = -Infinity;
  for (const point of ordered) {
    if (point.intelligence <= best) continue;
    frontier.push(point);
    best = point.intelligence;
  }
  return frontier;
}
