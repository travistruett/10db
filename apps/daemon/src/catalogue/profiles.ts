import {
  Effort,
  knownEfforts,
  ModelStatus,
  providerOf,
  SUPPORTED_ACCOUNT_KINDS,
  type Provider,
  type SupportedAccountKind,
} from '@10db/contracts';
import {
  listAccountModels,
  listAccounts,
  upsertModelProfiles,
  type CataloguedModelProfile,
  type WriteContext,
} from '@10db/db';
import { joinModel, RUNTIME_MAKER } from './join';
import type { Catalogue, CatalogueModel } from './source';
import { deriveTiers } from './tiers';

const EVERY_EFFORT: readonly Effort[] = Object.values(Effort);

/** A model some account offers, and the efforts it offers it at. */
interface Offer {
  readonly provider: Provider;
  /** The ID the profile is keyed by: the catalogue's own, or the one the account listed for an unknown model. */
  readonly model: string;
  readonly entry: CatalogueModel | null;
  readonly efforts: Set<Effort>;
}

const isSupported = (kind: string): kind is SupportedAccountKind =>
  SUPPORTED_ACCOUNT_KINDS.some((supported) => supported === kind);

/** The models an account with no list yet is assumed to run: its maker's own, retired ones left out. */
function assumedOffers(provider: Provider, catalogue: Catalogue): Offer[] {
  const own = catalogue.providers[RUNTIME_MAKER[provider]]?.models ?? [];
  return own
    .filter((m) => !m.deprecated)
    .map((entry) => {
      const efforts = knownEfforts(entry.efforts);
      return {
        provider,
        model: entry.id,
        entry,
        efforts: new Set(efforts.length > 0 ? efforts : EVERY_EFFORT),
      };
    });
}

/** Every model any account offers, once per provider and model, with the efforts of all the accounts joined. */
function collectOffers(ctx: WriteContext, catalogue: Catalogue): Offer[] {
  const offers = new Map<string, Offer>();
  for (const account of listAccounts(ctx.tx)) {
    if (!isSupported(account.kind)) continue;
    const provider = providerOf(account.kind);
    const rows = listAccountModels(ctx.tx, account.id);
    const found =
      rows.length === 0
        ? assumedOffers(provider, catalogue)
        : rows.map((row) => ({
            provider,
            model: row.model,
            entry: joinModel(row.model, provider, catalogue),
            // A list that reports no efforts for a model leaves every effort open.
            efforts: new Set(row.efforts.length > 0 ? row.efforts : EVERY_EFFORT),
          }));
    for (const offer of found) {
      const key = JSON.stringify([offer.provider, offer.model]);
      const seen = offers.get(key);
      if (seen) for (const effort of offer.efforts) seen.efforts.add(effort);
      else offers.set(key, offer);
    }
  }
  return [...offers.values()];
}

/** Whether the offer's runtime can run its maker's model, cannot, or the catalogue cannot name the maker. */
type Fit = 'runs' | 'refused' | 'unknown';

function fitOf(offer: Offer): Fit {
  const maker = offer.entry?.maker ?? null;
  if (maker === null) return 'unknown';
  return maker === RUNTIME_MAKER[offer.provider] ? 'runs' : 'refused';
}

/**
 * Writes a `model_profiles` row for every model and effort an account offers, joined to the catalogue: its
 * maker, family, list price and release date, and the tier and status the offered models rank to. Rows are
 * written disabled, so nothing routes on them until a router reads them. An account with no list yet offers
 * its maker's models. A model of another maker on a runtime that cannot run it is listed in the account's
 * rows only. A model the catalogue lacks is written Unknown, with no tier and no price. Profiles that exist
 * keep their scores, step counts and `enabled`; a second call with nothing changed writes nothing.
 */
export function reconcileProfiles(ctx: WriteContext, catalogue: Catalogue): void {
  const offers = collectOffers(ctx, catalogue);
  const runnable = offers.filter((o) => fitOf(o) === 'runs');
  const entries = new Map<string, CatalogueModel>();
  for (const { entry } of runnable) if (entry) entries.set(entry.id, entry);
  const tiers = deriveTiers([...entries.values()], new Set(entries.keys()));

  const rows: CataloguedModelProfile[] = [];
  for (const offer of offers) {
    const fit = fitOf(offer);
    if (fit === 'refused') continue;
    const { entry } = offer;
    const derived = fit === 'runs' && entry ? tiers.get(entry.id) : undefined;
    for (const effort of offer.efforts) {
      rows.push({
        provider: offer.provider,
        model: offer.model,
        effort,
        aaSlug: null,
        enabled: false,
        maker: fit === 'runs' ? (entry?.maker ?? null) : null,
        family: fit === 'runs' ? (entry?.family ?? null) : null,
        tier: derived?.tier ?? null,
        status: derived?.status ?? ModelStatus.Unknown,
        inputPrice: fit === 'runs' ? (entry?.inputPrice ?? null) : null,
        outputPrice: fit === 'runs' ? (entry?.outputPrice ?? null) : null,
        releaseDate: fit === 'runs' ? (entry?.releaseDate ?? null) : null,
      });
    }
  }
  upsertModelProfiles(ctx, rows);
}
