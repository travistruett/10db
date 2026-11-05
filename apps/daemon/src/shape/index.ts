// The Shape module (spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md): a
// conversation's read-only session, its plan drafts and Convert. `createShapeService` (service.ts)
// joins the composition root with the HTTP routes (daemon/shape-services.ts).

export { judgeShapeCall, privateHostProblem } from './confinement';
export {
  SHAPE_AGENTS,
  SHAPE_ALLOWED_TOOLS,
  SHAPE_BUILT_IN_TOOLS,
  SHAPE_DISALLOWED_TOOLS,
  SHAPE_SYSTEM_PROMPT,
  shapeToolset,
} from './policy';
export { createShapeJev, shadowAgreement } from './jev';
export { READ_CHARGE_MAX_BYTES } from './read-budget';
export {
  createShapeService,
  DEFAULT_SHAPE_TITLE,
  type ShapePrepared,
  type ShapePrepareInput,
  type ShapeService,
} from './service';
export { sizingMeasure } from './sizing';
