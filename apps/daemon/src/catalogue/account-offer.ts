import { AccountKind, knownEfforts, providerOf, type SupportedAccountKind } from '@10db/contracts';
import type { NewAccountModel } from '@10db/db';
import type { SeenModel } from '../sessions';
import { BEDROCK, joinModel, RUNTIME_MAKER } from './join';
import type { Catalogue, CatalogueModel } from './source';

type Prices = Pick<NewAccountModel, 'inputPrice' | 'outputPrice'>;
const NO_PRICE: Prices = { inputPrice: null, outputPrice: null };

const pricesOf = (entry: CatalogueModel): Prices => ({
  inputPrice: entry.inputPrice,
  outputPrice: entry.outputPrice,
});

/**
 * What this account pays for the model. A flat-rate plan pays nothing per token; an API key and a gateway pay
 * the maker's list price when the catalogue has the maker's own entry; Bedrock prices its own copy of the model.
 */
function priceOf(
  kind: SupportedAccountKind,
  entry: CatalogueModel | null,
  launchId: string,
  catalogue: Catalogue,
): Prices {
  switch (kind) {
    case AccountKind.ClaudeSubscription:
    case AccountKind.CodexSignin:
      return NO_PRICE;
    case AccountKind.AnthropicApiKey:
    case AccountKind.Gateway:
      return entry?.provider === RUNTIME_MAKER[providerOf(kind)] ? pricesOf(entry) : NO_PRICE;
    case AccountKind.Bedrock: {
      const copy = catalogue.providers[BEDROCK]?.models.find((m) => m.id === launchId);
      return copy ? pricesOf(copy) : NO_PRICE;
    }
  }
}

/** The region prefix, with its trailing dot, that the account's own IDs put before the maker: `us.anthropic.`. */
function regionPrefix(launchIds: readonly string[], maker: string): string | null {
  for (const id of launchIds) {
    const parts = id.split('.');
    const at = parts.indexOf(maker);
    if (at !== -1) return `${parts.slice(0, at + 1).join('.')}.`;
  }
  return null;
}

/**
 * Claude Code's Bedrock list understates what runs, so each family gets the catalogue's newest `amazon-bedrock`
 * model under the account's own prefix when it is newer than the family's newest listed model and not deprecated.
 * A family the list lacks is left alone: there is nothing to be newer than.
 */
function bedrockAdditions(
  listed: ReadonlyMap<string, { entry: CatalogueModel | null; launchId: string }>,
  catalogue: Catalogue,
): NewAccountModel[] {
  const provider = providerOf(AccountKind.Bedrock);
  const maker = RUNTIME_MAKER[provider];
  const prefix = regionPrefix(
    [...listed.values()].map((l) => l.launchId),
    maker,
  );
  if (prefix === null) return [];

  const newestListed = new Map<string, string>();
  for (const { entry } of listed.values()) {
    if (entry?.provider !== maker || entry.family === null || entry.releaseDate === null) continue;
    const seen = newestListed.get(entry.family);
    if (seen === undefined || entry.releaseDate > seen)
      newestListed.set(entry.family, entry.releaseDate);
  }

  const best = new Map<string, { own: CatalogueModel; copy: CatalogueModel }>();
  for (const copy of catalogue.providers[BEDROCK]?.models ?? []) {
    if (!copy.id.startsWith(prefix) || copy.deprecated) continue;
    const own = joinModel(copy.id, provider, catalogue);
    if (
      own?.provider !== maker ||
      own.deprecated ||
      own.family === null ||
      own.releaseDate === null
    )
      continue;
    const listedDate = newestListed.get(own.family);
    if (listedDate === undefined || own.releaseDate <= listedDate) continue;
    const held = best.get(own.family)?.own.releaseDate ?? null;
    if (held === null || own.releaseDate > held) best.set(own.family, { own, copy });
  }

  return [...best.values()]
    .filter(({ own }) => !listed.has(own.id))
    .map(({ own, copy }) => ({
      model: own.id,
      family: own.family,
      launchId: copy.id,
      efforts: knownEfforts(copy.efforts),
      ...pricesOf(copy),
    }));
}

/**
 * The rows an account's list becomes: each model joined to the catalogue by the concrete ID it launches with,
 * keyed by the catalogue's own ID, a model named twice kept once with its first row. A model the catalogue
 * lacks keeps the ID it was listed under, with no family and no price.
 */
export function offerFromList(
  kind: SupportedAccountKind,
  models: readonly SeenModel[],
  catalogue: Catalogue,
): NewAccountModel[] {
  const provider = providerOf(kind);
  const rows = new Map<string, NewAccountModel>();
  const listed = new Map<string, { entry: CatalogueModel | null; launchId: string }>();
  for (const m of models) {
    const launchId = m.resolvedId ?? m.id;
    const entry = joinModel(launchId, provider, catalogue);
    const model = entry?.id ?? launchId;
    if (rows.has(model)) continue;
    listed.set(model, { entry, launchId });
    rows.set(model, {
      model,
      family: entry?.family ?? null,
      launchId,
      efforts: [...m.efforts],
      ...priceOf(kind, entry, launchId, catalogue),
    });
  }
  const added = kind === AccountKind.Bedrock ? bedrockAdditions(listed, catalogue) : [];
  return [...rows.values(), ...added];
}
