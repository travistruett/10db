import {
  ConflictError,
  EventType,
  FlowInput,
  FlowPatch,
  InvalidError,
  mintId,
  NotFoundError,
  type FlowDto,
  type FlowId,
  type FlowStepDef,
} from '@10db/contracts';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';
import { findPersonaByKey } from './team';

/** A step's own persona must exist, be live, and play the step's role. */
function checkStepPersonas(db: DbReader, steps: readonly FlowStepDef[]): void {
  for (const step of steps) {
    if (step.persona === null) continue;
    const persona = findPersonaByKey(db, step.persona);
    if (!persona || persona.archived) throw new InvalidError(`No persona "${step.persona}"`);
    if (persona.role !== step.role)
      throw new InvalidError(`${persona.name} is a ${persona.role} persona, not ${step.role}`);
  }
}

export function insertFlow(ctx: WriteContext, input: FlowInput): FlowDto {
  const config = FlowInput.parse(input);
  if (findFlowByName(ctx.tx, config.name))
    throw new ConflictError(`A flow named "${config.name}" already exists`);
  checkStepPersonas(ctx.tx, config.steps);
  const row = { id: mintId('Flow'), ...config, createdAt: ctx.now, updatedAt: ctx.now };
  ctx.tx.insert(schema.flows).values(row).run();
  ctx.emit({ type: EventType.FlowSaved, entityType: 'flow', entityId: row.id });
  return row;
}

export function patchFlow(ctx: WriteContext, id: FlowId, patch: FlowPatch): FlowDto {
  const { steps } = FlowPatch.parse(patch);
  getFlow(ctx.tx, id);
  checkStepPersonas(ctx.tx, steps);
  ctx.tx
    .update(schema.flows)
    .set({ steps, updatedAt: ctx.now })
    .where(eq(schema.flows.id, id))
    .run();
  ctx.emit({ type: EventType.FlowSaved, entityType: 'flow', entityId: id });
  return getFlow(ctx.tx, id);
}

export function getFlow(db: DbReader, id: FlowId): FlowDto {
  const row = db.select().from(schema.flows).where(eq(schema.flows.id, id)).get();
  if (!row) throw new NotFoundError('flow', id);
  return row;
}

export function findFlowByName(db: DbReader, name: string): FlowDto | undefined {
  return db.select().from(schema.flows).where(eq(schema.flows.name, name)).get();
}

export function listFlows(db: DbReader): FlowDto[] {
  return db.select().from(schema.flows).orderBy(asc(schema.flows.name)).all();
}
