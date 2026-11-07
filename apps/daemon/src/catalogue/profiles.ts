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
  listModelProfiles,
  upsertModelProfiles,
  type CataloguedModelProfile,
  type WriteContext,
} from '@10db/db';
import { joinModel, RUNTIME_MAKER, runnability, type Runnability } from './join';
import type { Catalogue, CatalogueModel } from './source';
import { deriveTiers } from './tiers';

const EVERY_EFFORT: readonly Effort[] = Object.values(Effort);

/** A model some account offers, and the efforts it offers it at. */
interface Offer {
  readonly provider: Provider;
  /** The ID the profile is keyed by: the catalogue's own, or the one the account listed for an unknown model. */
  readonly model: string;
  readonly entry: CatalogueModel | null;
  readonly fit: Runnability;
  readonly efforts: Set<Effort>;
  /**
   * Whether the offer takes part in ranking. A model only assumed for an account with no list is left out while
   * any account of its maker has a real list, so an unread account cannot supersede what another one offers.
   */
  ranked: boolean;
}

const isSupported = (kind: string): kind is SupportedAccountKind =>
  SUPPORTED_ACCOUNT_KINDS.some((supported) => supported === kind);

/** The models an account with no list yet is assumed to run: its maker's own, retired ones left out. */
function assumedOffers(provider: Provider, catalogue: Catalogue, ranked: boolean): Offer[] {
  const own = catalogue.providers[RUNTIME_MAKER[provider]]?.models ?? [];
  return own
    .filter((m) => !m.deprecated)
    .map((entry) => {
      const efforts = knownEfforts(entry.efforts);
      return {
        provider,
        model: entry.id,
        entry,
        fit: 'runs',
        ranked,
        efforts: new Set(efforts.length > 0 ? efforts : EVERY_EFFORT),
      };
    });
}

/** Every model any account offers, once per provider and model, with the efforts of all the accounts joined. */
function collectOffers(ctx: WriteContext, catalogue: Catalogue): Offer[] {
  const accounts = listAccounts(ctx.tx).filter((account) => isSupported(account.kind));
  const lists = new Map(accounts.map((a) => [a.id, listAccountModels(ctx.tx, a.id)]));
  const withList = new Set<Provider>();
  for (const account of accounts) {
    if (isSupported(account.kind) && (lists.get(account.id)?.length ?? 0) > 0)
      withList.add(providerOf(account.kind));
  }

  const offers = new Map<string, Offer>();
  for (const account of accounts) {
    if (!isSupported(account.kind)) continue;
    const provider = providerOf(account.kind);
    const rows = lists.get(account.id) ?? [];
    const found: Offer[] =
      rows.length === 0
        ? assumedOffers(provider, catalogue, !withList.has(provider))
        : rows.map((row) => {
            const fit = runnability(row.model, provider, catalogue);
            return {
              provider,
              model: row.model,
              entry: fit === 'unknown' ? null : joinModel(row.model, provider, catalogue),
              fit,
              ranked: true,
              // A list that reports no efforts for a model leaves every effort open.
              efforts: new Set(row.efforts.length > 0 ? row.efforts : EVERY_EFFORT),
            };
          });
    for (const offer of found) {
      const key = JSON.stringify([offer.provider, offer.model]);
      const seen = offers.get(key);
      if (seen) {
        for (const effort of offer.efforts) seen.efforts.add(effort);
        seen.ranked ||= offer.ranked;
      } else offers.set(key, offer);
    }
  }
  return [...offers.values()];
}

/**
 * Writes a `model_profiles` row for every model and effort an account offers, joined to the catalogue: its
 * maker, family, list price and release date, and the tier and status the offered models rank to. Only the
 * maker's own entries are ranked and priced; a model known only through Bedrock's copy gets no tier and no
 * price. Rows are written disabled, so nothing routes on them until a router reads them. An account with no
 * list yet offers its maker's models, unranked while another account of the maker has a real list. A model the
 * runtime cannot run is listed in the account's rows only. A model the catalogue lacks is written Unknown.
 * Profiles that exist keep their scores, step counts and `enabled`; a profile no account offers any more loses
 * its tier and status. A second call with nothing changed writes nothing.
 */
export function reconcileProfiles(ctx: WriteContext, catalogue: Catalogue): void {
  const offers = collectOffers(ctx, catalogue);
  const ownEntry = (offer: Offer): CatalogueModel | null =>
    offer.entry?.provider === RUNTIME_MAKER[offer.provider] ? offer.entry : null;

  const entries = new Map<string, CatalogueModel>();
  for (const offer of offers) {
    const own = ownEntry(offer);
    if (offer.fit === 'runs' && offer.ranked && own) entries.set(own.id, own);
  }
  const tiers = deriveTiers([...entries.values()], new Set(entries.keys()));

  const rows: CataloguedModelProfile[] = [];
  const wanted = new Set<string>();
  for (const offer of offers) {
    if (offer.fit === 'refused') continue;
    const own = ownEntry(offer);
    const known = offer.fit === 'runs' ? offer.entry : null;
    const derived = offer.ranked && own ? tiers.get(own.id) : undefined;
    for (const effort of offer.efforts) {
      wanted.add(JSON.stringify([offer.provider, offer.model, effort]));
      rows.push({
        provider: offer.provider,
        model: offer.model,
        effort,
        aaSlug: null,
        enabled: false,
        maker: known?.maker ?? null,
        family: known?.family ?? null,
        tier: derived?.tier ?? null,
        status: derived?.status ?? (offer.ranked ? ModelStatus.Unknown : null),
        inputPrice: own?.inputPrice ?? null,
        outputPrice: own?.outputPrice ?? null,
        releaseDate: known?.releaseDate ?? null,
      });
    }
  }
  for (const p of listModelProfiles(ctx.tx)) {
    if (wanted.has(JSON.stringify([p.provider, p.model, p.effort]))) continue;
    if (p.tier === null && p.status === null) continue;
    rows.push({ ...p, tier: null, status: null });
  }
  upsertModelProfiles(ctx, rows);
}
