import { Provider } from '@10db/contracts';
import { joinModel, RUNTIME_MAKER } from './join';
import type { Catalogue } from './source';

const DATE_SUFFIX = /-\d{8}$/;

/** The runtime whose maker an OpenRouter `maker/model` id names; any other maker, or a router, has none. */
export function openRouterProvider(id: string): Provider | null {
  const slash = id.indexOf('/');
  if (slash === -1) return null;
  const maker = id.slice(0, slash);
  for (const provider of Object.values(Provider))
    if (RUNTIME_MAKER[provider] === maker) return provider;
  return null;
}

/**
 * The catalogue model id an OpenRouter id (or dated permaslug) names, or null. A `~maker/...-latest` router
 * follows whatever is newest, so it names no one model; an id the catalogue cannot place exactly, canonically
 * or by normalised form, or places on two entries, is null. There is no fuzzy match.
 */
export function joinOpenRouterId(id: string, catalogue: Catalogue): string | null {
  const provider = openRouterProvider(id);
  if (provider === null) return null;
  const model = id.slice(id.indexOf('/') + 1).replace(DATE_SUFFIX, '');
  return joinModel(model, provider, catalogue)?.id ?? null;
}
