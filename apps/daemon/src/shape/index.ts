// The Shape module (spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md): a
// conversation's read-only session, its plan drafts and Convert. `createShapeService` (service.ts)
// joins the composition root with the HTTP routes (daemon/shape-services.ts).

export { shapeAgentModels } from './agent-models';
export { judgePlanTool, judgeShapeCall, privateHostProblem, type ShapeAccess } from './confinement';
export type { ShapeLaunch } from './session-launch';
export { gitTrackedFiles } from './ceremony';
export {
  SHAPE_AGENTS,
  SHAPE_ALLOWED_TOOLS,
  SHAPE_BUILT_IN_TOOLS,
  SHAPE_DISALLOWED_TOOLS,
  PLANNING_STUB,
  owedPlanningRules,
  shapeSystemPrompt,
  shapeToolset,
} from './policy';
export { PIN_IMPORTED } from './rounds';
export type { PlanParts } from './plan-parts';
export { createShapeJev, shadowAgreement } from './jev';
export {
  createShapeService,
  type ShapePrepared,
  type ShapePrepareInput,
  type ShapeService,
} from './service';
export { sizingMeasure } from './sizing';
