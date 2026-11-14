import { PersonaInput } from '@10db/contracts';
import {
  SEED_BUILDER_NAME,
  BUILDER_HANDLE,
  findPersonByHandle,
  findPersonaByKey,
  insertPerson,
  insertPersona,
} from '@10db/db';
import type { HarnessPersona } from '@10db/harness';
import type { StateStore } from '../events';
import { seedKinds } from './seed-kinds';

/**
 * Adds whatever is missing, in one transaction; never changes a row that exists, so the builder's
 * edits win. The kinds are offered once and then left to the builder.
 */
export function seedTeam(state: StateStore, personas: readonly HarnessPersona[]): void {
  state.write((ctx) => {
    // The parse is the boundary between the harness's own enums and the contracts'.
    for (const persona of personas)
      if (!findPersonaByKey(ctx.tx, persona.key)) insertPersona(ctx, PersonaInput.parse(persona));
    if (!findPersonByHandle(ctx.tx, BUILDER_HANDLE))
      insertPerson(ctx, { handle: BUILDER_HANDLE, name: SEED_BUILDER_NAME, isBuilder: true });
    seedKinds(ctx);
  });
}
