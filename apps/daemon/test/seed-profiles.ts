import { Effort, knownEfforts, ModelStatus, Provider } from '@10db/contracts';
import { upsertModelProfiles, type CataloguedModelProfile } from '@10db/db';
import { deriveTiers, parseCatalogue } from '../src/catalogue';
import type { StateStore } from '../src/events';
import { readModelsDevFixture } from './models-dev-fixture';

/** The maker whose models each runtime runs. */
const MAKER: Readonly<Record<Provider, string>> = {
  [Provider.Claude]: 'anthropic',
  [Provider.Codex]: 'openai',
};

/**
 * Writes the profiles an account with no list yet would be assumed to run: every model of the runtime's maker in
 * the catalogue fixture, at every effort, ranked the way a real catalogue is, unscored. Tests that need a
 * model's tier, price or status read it from the fixture, not from a table in the source.
 */
export function seedProfiles(state: StateStore): void {
  const catalogue = parseCatalogue(readModelsDevFixture());
  const rows: CataloguedModelProfile[] = [];
  for (const provider of Object.values(Provider)) {
    const own = (catalogue.providers[MAKER[provider]]?.models ?? []).filter((m) => !m.deprecated);
    const tiers = deriveTiers(own, new Set(own.map((m) => m.id)));
    for (const model of own) {
      const derived = tiers.get(model.id);
      const efforts = knownEfforts(model.efforts);
      for (const effort of efforts.length > 0 ? efforts : Object.values(Effort)) {
        rows.push({
          provider,
          model: model.id,
          effort,
          aaSlug: null,
          enabled: derived?.status === ModelStatus.Current,
          maker: model.maker,
          family: model.family,
          tier: derived?.tier ?? null,
          status: derived?.status ?? null,
          inputPrice: model.inputPrice,
          outputPrice: model.outputPrice,
          releaseDate: model.releaseDate,
        });
      }
    }
  }
  state.write((ctx) => {
    upsertModelProfiles(ctx, rows);
  });
}
