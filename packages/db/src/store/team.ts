import {
  ConflictError,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  PersonaInput,
  PersonaPatch,
  TeamInput,
  type PersonaDto,
  type PersonaId,
  type PersonDto,
  type PersonId,
  type PersonInput,
  type ProjectId,
  type TeamDto,
} from '@10db/contracts';
import { asc, eq, inArray } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

/** The person running this app: every card nobody else owns goes to them (spec §7). */
export const BUILDER_HANDLE = 'me';

type PersonaRow = typeof schema.personas.$inferSelect;
const personaDto = (row: PersonaRow): PersonaDto => ({ ...row, modelPin: row.modelPin ?? null });

export function insertPersona(ctx: WriteContext, input: PersonaInput): PersonaDto {
  const config = PersonaInput.parse(input);
  if (findPersonaByKey(ctx.tx, config.key))
    throw new ConflictError(`A persona with the key "${config.key}" already exists`);
  const row = {
    id: mintId('Persona'),
    ...config,
    archived: false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.personas).values(row).run();
  ctx.emit({ type: EventType.PersonaSaved, entityType: 'persona', entityId: row.id });
  return personaDto(row);
}

/** Every save is an event; a changed prompt keeps its previous text there, as the prompt's history. */
export function patchPersona(ctx: WriteContext, id: PersonaId, patch: PersonaPatch): PersonaDto {
  const changes = PersonaPatch.parse(patch);
  const before = getPersona(ctx.tx, id);
  ctx.tx
    .update(schema.personas)
    .set({ ...changes, updatedAt: ctx.now })
    .where(eq(schema.personas.id, id))
    .run();
  const promptChanged =
    changes.instructions !== undefined && changes.instructions !== before.instructions;
  ctx.emit({
    type: EventType.PersonaSaved,
    entityType: 'persona',
    entityId: id,
    data: promptChanged ? { previousInstructions: before.instructions } : {},
  });
  return getPersona(ctx.tx, id);
}

export function getPersona(db: DbReader, id: PersonaId): PersonaDto {
  const row = db.select().from(schema.personas).where(eq(schema.personas.id, id)).get();
  if (!row) throw new NotFoundError('persona', id);
  return personaDto(row);
}

export function findPersonaByKey(db: DbReader, key: string): PersonaDto | undefined {
  const row = db.select().from(schema.personas).where(eq(schema.personas.key, key)).get();
  return row ? personaDto(row) : undefined;
}

export function listPersonas(
  db: DbReader,
  opts: { readonly includeArchived?: boolean } = {},
): PersonaDto[] {
  const rows = db.select().from(schema.personas).orderBy(asc(schema.personas.key)).all();
  return rows.filter((r) => opts.includeArchived === true || !r.archived).map(personaDto);
}

export function insertPerson(
  ctx: WriteContext,
  input: PersonInput & { readonly isBuilder?: boolean },
): PersonDto {
  if (findPersonByHandle(ctx.tx, input.handle))
    throw new ConflictError(`Someone already has the handle "${input.handle}"`);
  const row = {
    id: mintId('Person'),
    handle: input.handle,
    name: input.name,
    isBuilder: input.isBuilder ?? false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.people).values(row).run();
  ctx.emit({ type: EventType.PersonSaved, entityType: 'person', entityId: row.id });
  return row;
}

export function getPerson(db: DbReader, id: PersonId): PersonDto {
  const row = db.select().from(schema.people).where(eq(schema.people.id, id)).get();
  if (!row) throw new NotFoundError('person', id);
  return row;
}

export function findPersonByHandle(db: DbReader, handle: string): PersonDto | undefined {
  return db.select().from(schema.people).where(eq(schema.people.handle, handle)).get();
}

export function listPeople(db: DbReader): PersonDto[] {
  return db.select().from(schema.people).orderBy(asc(schema.people.handle)).all();
}

export function getTeam(db: DbReader, projectId: ProjectId): TeamDto {
  const bindings = db
    .select({ role: schema.teamBindings.role, personaId: schema.teamBindings.personaId })
    .from(schema.teamBindings)
    .where(eq(schema.teamBindings.projectId, projectId))
    .orderBy(asc(schema.teamBindings.role))
    .all();
  const members = db
    .select({ personId: schema.teamMembers.personId })
    .from(schema.teamMembers)
    .where(eq(schema.teamMembers.projectId, projectId))
    .orderBy(asc(schema.teamMembers.personId))
    .all()
    .map((m) => m.personId);
  return { projectId, bindings, members };
}

/** Replaces the project's bindings and members; a persona must play its own role and not be archived. */
export function setTeam(ctx: WriteContext, projectId: ProjectId, input: TeamInput): TeamDto {
  const team = TeamInput.parse(input);
  for (const binding of team.bindings) {
    const persona = getPersona(ctx.tx, binding.personaId);
    if (persona.archived) throw new InvalidError(`${persona.name} is archived`);
    if (persona.role !== binding.role)
      throw new InvalidError(`${persona.name} is a ${persona.role} persona, not ${binding.role}`);
  }
  if (team.members.length > 0) {
    const found = ctx.tx
      .select({ id: schema.people.id })
      .from(schema.people)
      .where(inArray(schema.people.id, team.members))
      .all();
    if (found.length !== team.members.length) throw new InvalidError('A member does not exist');
  }
  ctx.tx.delete(schema.teamBindings).where(eq(schema.teamBindings.projectId, projectId)).run();
  ctx.tx.delete(schema.teamMembers).where(eq(schema.teamMembers.projectId, projectId)).run();
  if (team.bindings.length > 0)
    ctx.tx
      .insert(schema.teamBindings)
      .values(team.bindings.map((b) => ({ projectId, ...b })))
      .run();
  if (team.members.length > 0)
    ctx.tx
      .insert(schema.teamMembers)
      .values(team.members.map((personId) => ({ projectId, personId })))
      .run();
  ctx.emit({ type: EventType.TeamSaved, entityType: 'team', entityId: projectId });
  return getTeam(ctx.tx, projectId);
}
