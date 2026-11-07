import { PersonaInput } from '@10db/contracts';
import {
  BUILDER_HANDLE,
  findFlowByName,
  findPersonByHandle,
  findPersonaByKey,
  insertFlow,
  insertPerson,
  insertPersona,
} from '@10db/db';
import type { HarnessPersona } from '@10db/harness';
import type { StateStore } from '../events';
import { DEFAULT_FLOWS } from '../routing';
import { seedPatterns } from './seed-patterns';

/**
 * Adds whatever is missing, in one transaction; never changes a row that exists, so the builder's
 * edits win. The high-risk pattern is offered once and then left to the builder.
 */
export function seedTeam(state: StateStore, personas: readonly HarnessPersona[]): void {
  state.write((ctx) => {
    // Personas come before flows, because a flow may name a persona. The parse is the boundary
    // between the harness's own enums and the contracts'.
    for (const persona of personas)
      if (!findPersonaByKey(ctx.tx, persona.key)) insertPersona(ctx, PersonaInput.parse(persona));
    for (const flow of DEFAULT_FLOWS) if (!findFlowByName(ctx.tx, flow.name)) insertFlow(ctx, flow);
    if (!findPersonByHandle(ctx.tx, BUILDER_HANDLE))
      insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true });
    seedPatterns(ctx);
  });
}
