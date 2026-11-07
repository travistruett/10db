import { Provider } from '@10db/contracts';
import type { Catalogue, CatalogueModel } from './source';

/**
 * The lab whose models a runtime can run. Claude Code runs Anthropic's models wherever it is pointed,
 * Bedrock and gateways included, and Codex runs OpenAI's; this is a fact about the runtime, not a list of models.
 */
export const RUNTIME_MAKER: Readonly<Record<Provider, string>> = {
  [Provider.Claude]: 'anthropic',
  [Provider.Codex]: 'openai',
};

/** The provider whose entries carry a region prefix and a version suffix on an exact ID. */
export const BEDROCK = 'amazon-bedrock';

/** A Bedrock version suffix: `-v1` or `-v1:0`. */
const BEDROCK_VERSION = /-v\d+(:\d+)?$/;

/**
 * The maker's own ID inside a Bedrock-style one. Nothing lists regions, so the vendor segment is the one that
 * names a provider of the catalogue, and everything before and including it goes, with the version suffix.
 */
function canonicalId(id: string, catalogue: Catalogue): string {
  const parts = id.split('.');
  const vendor = parts.findIndex((part) => Object.hasOwn(catalogue.providers, part));
  // A version suffix is Bedrock's only where a vendor segment says the ID is Bedrock-style.
  if (vendor === -1) return id;
  return parts
    .slice(vendor + 1)
    .join('.')
    .replace(BEDROCK_VERSION, '');
}

/** Case, a vendor prefix before a slash, and dots against hyphens do not tell two IDs apart. */
const normalised = (id: string): string =>
  id
    .toLowerCase()
    .replace(/^[^/]*\//, '')
    .replaceAll('.', '-');

/**
 * The catalogue entry for an ID an account reports: the maker's own entry by exact ID, then by the canonical
 * ID of a Bedrock-style one, then by normalised ID, and last the exact `amazon-bedrock` entry. A normalised
 * match that two entries share is no match. An ID that joins nothing is null; there is no fuzzy match.
 */
export function joinModel(
  id: string,
  provider: Provider,
  catalogue: Catalogue,
): CatalogueModel | null {
  const own = catalogue.providers[RUNTIME_MAKER[provider]]?.models ?? [];
  const canonical = canonicalId(id, catalogue);
  const exact = own.find((m) => m.id === id) ?? own.find((m) => m.id === canonical);
  if (exact) return exact;
  const alike = own.filter((m) => normalised(m.id) === normalised(canonical));
  if (alike.length === 1) return alike[0] ?? null;
  if (alike.length > 1) return null;
  return catalogue.providers[BEDROCK]?.models.find((m) => m.id === id) ?? null;
}

/** Whether a runtime can run a model: yes, no, or the catalogue cannot tell. */
export type Runnability = 'runs' | 'refused' | 'unknown';

/**
 * Whether the provider's runtime can run the model an account lists, judged apart from the join. A model that
 * joins runs when its maker is the runtime's, and is refused when the maker is another or the catalogue cannot
 * name it. One that joins nothing is still refused when another provider of the catalogue lists it, by its exact
 * ID, its canonical ID or its `vendor/` ID; otherwise it is unknown.
 */
export function runnability(id: string, provider: Provider, catalogue: Catalogue): Runnability {
  const entry = joinModel(id, provider, catalogue);
  const maker = RUNTIME_MAKER[provider];
  if (entry) return entry.maker === maker ? 'runs' : 'refused';
  const [vendor, rest] = id.includes('/') ? [id.split('/')[0], id.slice(id.indexOf('/') + 1)] : [];
  for (const [name, { models }] of Object.entries(catalogue.providers)) {
    if (name === maker) continue;
    const named = [id, canonicalId(id, catalogue), ...(vendor === name && rest ? [rest] : [])];
    if (models.some((m) => named.includes(m.id))) return 'refused';
  }
  return 'unknown';
}
