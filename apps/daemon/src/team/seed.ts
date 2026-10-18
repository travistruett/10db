import { PersonaInput } from '@10db/contracts';
import {
  BUILDER_HANDLE,
  findFlowByName,
  findModelProfile,
  findPersonByHandle,
  findPersonaByKey,
  insertFlow,
  insertModelProfile,
  insertPerson,
  insertPersona,
} from '@10db/db';
import type { HarnessPersona } from '@10db/harness';
import type { StateStore } from '../events';
import { DEFAULT_FLOWS, SEED_PROFILES } from '../routing';

/** Adds whatever is missing, in one transaction; never changes a row that exists, so the builder's edits win. */
export function seedTeam(state: StateStore, personas: readonly HarnessPersona[]): void {
  state.write((ctx) => {
    for (const profile of SEED_PROFILES)
      if (!findModelProfile(ctx.tx, profile.provider, profile.model, profile.effort))
        insertModelProfile(ctx, profile);
    // Personas come before flows, because a flow may name a persona. The parse is the boundary
    // between the harness's own enums and the contracts'.
    for (const persona of personas)
      if (!findPersonaByKey(ctx.tx, persona.key)) insertPersona(ctx, PersonaInput.parse(persona));
    for (const flow of DEFAULT_FLOWS) if (!findFlowByName(ctx.tx, flow.name)) insertFlow(ctx, flow);
    if (!findPersonByHandle(ctx.tx, BUILDER_HANDLE))
      insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true });
  });
}
