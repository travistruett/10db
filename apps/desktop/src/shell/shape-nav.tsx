import { ShapeState, type ShapeDto } from '@10db/contracts';

/**
 * The selected project's most recent conversation not yet converted, a running turn included: where
 * Plan's rail item opens, which is the blank composer (`/shape`) when there is none.
 */
export function latestOpenShape(shapes: readonly ShapeDto[] | undefined): ShapeDto | undefined {
  // `useShapes` lists the most recently updated first.
  return shapes?.find((shape) => shape.state !== ShapeState.Converted);
}
