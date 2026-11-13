import {
  ConflictError,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  PersonaInput,
  PersonaPatch,
  SendMode,
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
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';

/** The person running this app: every card nobody else owns goes to them (spec §7). */
export const BUILDER_HANDLE = 'me';

/** The name the builder has until they pick their Slack member in Settings › Integrations. */
export const SEED_BUILDER_NAME = 'You';

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

type PersonRow = typeof schema.people.$inferSelect;
type ContactRow = typeof schema.personContacts.$inferSelect;

const slackOf = (c: ContactRow | undefined | null): PersonDto['slack'] =>
  c
    ? {
        teamId: c.teamId,
        userId: c.userId,
        dmChannelId: c.dmChannelId,
        sendMode: c.sendMode,
        dailyLimit: c.dailyLimit,
      }
    : null;

const personDto = (row: PersonRow, contact: ContactRow | undefined | null): PersonDto => ({
  ...row,
  slack: slackOf(contact),
});

function contactOf(db: DbReader, personId: PersonId): ContactRow | undefined {
  return db
    .select()
    .from(schema.personContacts)
    .where(eq(schema.personContacts.personId, personId))
    .get();
}

/** Writes the person's Slack contact: none removes it; a change of Slack user forgets the DM channel. */
function writeContact(ctx: WriteContext, personId: PersonId, slack: PersonInput['slack']): void {
  const existing = contactOf(ctx.tx, personId);
  if (!slack) {
    if (existing)
      ctx.tx
        .delete(schema.personContacts)
        .where(eq(schema.personContacts.personId, personId))
        .run();
    return;
  }
  const fields = {
    teamId: slack.teamId,
    userId: slack.userId,
    sendMode: slack.sendMode ?? SendMode.Review,
    dailyLimit: slack.dailyLimit === undefined ? 10 : slack.dailyLimit,
    updatedAt: ctx.now,
  };
  if (!existing) {
    ctx.tx
      .insert(schema.personContacts)
      .values({ id: mintId('PersonContact'), personId, ...fields, createdAt: ctx.now })
      .run();
    return;
  }
  const sameUser = existing.userId === fields.userId && existing.teamId === fields.teamId;
  ctx.tx
    .update(schema.personContacts)
    .set(sameUser ? fields : { ...fields, dmChannelId: null, dmCursor: null })
    .where(eq(schema.personContacts.personId, personId))
    .run();
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
  writeContact(ctx, row.id, input.slack ?? null);
  ctx.emit({ type: EventType.PersonSaved, entityType: 'person', entityId: row.id });
  return getPerson(ctx.tx, row.id);
}

/** Replaces a person's handle, name and Slack contact. The builder flag never changes. */
export function updatePerson(ctx: WriteContext, id: PersonId, input: PersonInput): PersonDto {
  const current = getPerson(ctx.tx, id);
  const taken = findPersonByHandle(ctx.tx, input.handle);
  if (taken && taken.id !== id)
    throw new ConflictError(`Someone already has the handle "${input.handle}"`);
  ctx.tx
    .update(schema.people)
    .set({ handle: input.handle, name: input.name, updatedAt: ctx.now })
    .where(eq(schema.people.id, id))
    .run();
  writeContact(ctx, id, input.slack ?? null);
  ctx.emit({ type: EventType.PersonSaved, entityType: 'person', entityId: id });
  return { ...getPerson(ctx.tx, id), isBuilder: current.isBuilder };
}

/**
 * Removes a person with their team rows and Slack contact. The builder, a goal's owner, a person on a
 * goal criterion and a person a route names stay: the caller says which.
 */
export function removePerson(ctx: WriteContext, id: PersonId): void {
  const person = getPerson(ctx.tx, id);
  if (person.isBuilder) throw new ConflictError('The builder cannot be removed');
  const owns = ctx.tx
    .select({ id: schema.goals.id })
    .from(schema.goals)
    .where(eq(schema.goals.ownerId, id))
    .get();
  if (owns) throw new ConflictError(`${person.name} owns a goal`);
  const criterion = ctx.tx
    .select({ id: schema.goalCriteria.id })
    .from(schema.goalCriteria)
    .where(eq(schema.goalCriteria.personId, id))
    .get();
  if (criterion) throw new ConflictError(`${person.name} is on a goal criterion`);
  const route = ctx.tx
    .select({ id: schema.routingRules.id })
    .from(schema.routingRules)
    .where(eq(schema.routingRules.personId, id))
    .get();
  if (route) throw new ConflictError(`${person.name} is named by a route`);
  ctx.tx.delete(schema.teamMembers).where(eq(schema.teamMembers.personId, id)).run();
  ctx.tx.delete(schema.goalViews).where(eq(schema.goalViews.personId, id)).run();
  ctx.tx
    .update(schema.stakeholderSendPeople)
    .set({ personId: null })
    .where(eq(schema.stakeholderSendPeople.personId, id))
    .run();
  ctx.tx.delete(schema.personContacts).where(eq(schema.personContacts.personId, id)).run();
  ctx.tx.delete(schema.people).where(eq(schema.people.id, id)).run();
  ctx.emit({ type: EventType.PersonRemoved, entityType: 'person', entityId: id });
}

export function getPerson(db: DbReader, id: PersonId): PersonDto {
  const row = db.select().from(schema.people).where(eq(schema.people.id, id)).get();
  if (!row) throw new NotFoundError('person', id);
  return personDto(row, contactOf(db, id));
}

export function findPersonByHandle(db: DbReader, handle: string): PersonDto | undefined {
  const row = db.select().from(schema.people).where(eq(schema.people.handle, handle)).get();
  return row && personDto(row, contactOf(db, row.id));
}

export function listPeople(db: DbReader): PersonDto[] {
  const contacts = new Map(
    db
      .select()
      .from(schema.personContacts)
      .all()
      .map((c) => [c.personId, c]),
  );
  return db
    .select()
    .from(schema.people)
    .orderBy(asc(schema.people.handle))
    .all()
    .map((row) => personDto(row, contacts.get(row.id)));
}

function requireContact(db: DbReader, personId: PersonId): ContactRow {
  const contact = contactOf(db, personId);
  if (!contact) throw new NotFoundError('Slack contact', personId);
  return contact;
}

function touchContact(
  ctx: WriteContext,
  personId: PersonId,
  set: Partial<typeof schema.personContacts.$inferInsert>,
): void {
  requireContact(ctx.tx, personId);
  ctx.tx
    .update(schema.personContacts)
    .set({ ...set, updatedAt: ctx.now })
    .where(eq(schema.personContacts.personId, personId))
    .run();
  ctx.emit({ type: EventType.PersonSaved, entityType: 'person', entityId: personId });
}

/** The DM channel 10db learned for the person on the first send. */
export function setDmChannel(ctx: WriteContext, personId: PersonId, channelId: string): void {
  touchContact(ctx, personId, { dmChannelId: channelId });
}

/** The newest `ts` of the person's DM the reply watch has read; null before the first read. */
export function getDmCursor(db: DbReader, personId: PersonId): string | null {
  return requireContact(db, personId).dmCursor;
}

export function setDmCursor(ctx: WriteContext, personId: PersonId, ts: string): void {
  touchContact(ctx, personId, { dmCursor: ts });
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

/** Replaces the project's bindings and members; a persona must exist, play its own role and not be archived. */
export function setTeam(ctx: WriteContext, projectId: ProjectId, input: TeamInput): TeamDto {
  const team = TeamInput.parse(input);
  getProject(ctx.tx, projectId);
  for (const binding of team.bindings) {
    let persona: PersonaDto;
    try {
      persona = getPersona(ctx.tx, binding.personaId);
    } catch (error) {
      throw error instanceof NotFoundError
        ? new InvalidError(`No persona ${binding.personaId}`)
        : error;
    }
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
