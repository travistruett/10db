import { mintId, type PersonaId, type ProjectId, type TaskId } from '@10db/contracts';
import { eq } from 'drizzle-orm';
import type {
  LegacyFlow,
  LegacyModelPin,
  LegacyPatternMatch,
  LegacyRiskTag,
  LegacyRoleSetting,
} from '../legacy-types';
import * as schema from '../schema';
import type { WriteContext } from './store';

/*
 * Writers for the routing tables the playbook replaced, for the test of what reads the old rows. Nothing in
 * 10db writes those tables any more; the daemon's tests have their own (`apps/daemon/test/legacy-rows.ts`).
 */

type FlowStepFields = Partial<LegacyFlow['steps'][number]> &
  Pick<LegacyFlow['steps'][number], 'role'>;

/** Inserts a flow as the tables held it, steps filled out with a need and no skip rules. */
export function seedLegacyFlow(
  ctx: WriteContext,
  flow: { readonly name: string; readonly steps: readonly FlowStepFields[] },
): LegacyFlow {
  const row = {
    id: mintId('Flow'),
    name: flow.name,
    steps: flow.steps.map((step) => ({ need: 40, skip: [], persona: null, ...step })),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.flows).values(row).run();
  return { id: row.id, name: row.name, steps: row.steps };
}

export function seedLegacyRoleSetting(ctx: WriteContext, setting: LegacyRoleSetting): void {
  ctx.tx
    .insert(schema.roleSettings)
    .values({ ...setting, updatedAt: ctx.now })
    .run();
}

/** A pattern as a test writes it: the match fields it leaves out are the empty ones. */
export interface LegacyPatternSeed {
  readonly name: string;
  readonly match: Partial<LegacyPatternMatch>;
  readonly setting: LegacyRoleSetting['setting'];
}

/** Adds patterns to one scope, in the order given. */
export function seedLegacyPatterns(
  ctx: WriteContext,
  projectId: ProjectId | null,
  patterns: readonly LegacyPatternSeed[],
): void {
  patterns.forEach((pattern, position) => {
    ctx.tx
      .insert(schema.patterns)
      .values({
        id: mintId('Pattern'),
        projectId,
        name: pattern.name,
        match: { roles: [], riskTags: [], areas: [], retryOnly: false, ...pattern.match },
        setting: pattern.setting,
        position,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run();
  });
}

/** Sets a persona's own pin and minimum score. */
export function seedLegacyPersonaPin(
  ctx: WriteContext,
  personaId: PersonaId,
  pin: { readonly modelPin?: LegacyModelPin | null; readonly minimumScore?: number | null },
): void {
  ctx.tx
    .update(schema.personas)
    .set({
      ...(pin.modelPin === undefined ? {} : { modelPin: pin.modelPin }),
      ...(pin.minimumScore === undefined ? {} : { minimumScore: pin.minimumScore }),
    })
    .where(eq(schema.personas.id, personaId))
    .run();
}

/** Binds a project's role to a persona, replacing the binding the role had. */
export function seedLegacyBinding(
  ctx: WriteContext,
  binding: {
    readonly projectId: ProjectId;
    readonly role: LegacyRoleSetting['role'];
    readonly personaId: PersonaId;
  },
): void {
  ctx.tx
    .insert(schema.teamBindings)
    .values(binding)
    .onConflictDoUpdate({
      target: [schema.teamBindings.projectId, schema.teamBindings.role],
      set: { personaId: binding.personaId },
    })
    .run();
}

/** Gives a task the risk tags and flow it would have carried. */
export function seedLegacyTaskRouting(
  ctx: WriteContext,
  taskId: TaskId,
  routing: {
    readonly riskTags?: readonly LegacyRiskTag[];
    readonly flowId?: LegacyFlow['id'] | null;
  },
): void {
  ctx.tx
    .update(schema.tasks)
    .set({
      ...(routing.riskTags === undefined ? {} : { riskTags: [...routing.riskTags] }),
      ...(routing.flowId === undefined ? {} : { flowId: routing.flowId }),
    })
    .where(eq(schema.tasks.id, taskId))
    .run();
}

/** Names a flow as a project's default. */
export function seedLegacyProjectFlow(
  ctx: WriteContext,
  projectId: ProjectId,
  flowId: LegacyFlow['id'],
): void {
  ctx.tx.update(schema.projects).set({ flowId }).where(eq(schema.projects.id, projectId)).run();
}
