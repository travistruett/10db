import {
  providerOf,
  ModelStatus,
  type AccountDto,
  type AccountId,
  type AccountModelDto,
  type ModelProfileDto,
  type ModelRowDto,
  type Provider,
} from '@10db/contracts';
import { joinModel, RUNTIME_MAKER, runnability } from './join';
import type { Catalogue, CatalogueModel } from './source';

/** What the list needs to know of an account: which it is, and whether it still counts. */
export type ModelRowAccount = Pick<AccountDto, 'id' | 'kind' | 'archived'>;

export interface ModelRowsInput {
  readonly profiles: readonly ModelProfileDto[];
  readonly offers: readonly AccountModelDto[];
  readonly accounts: readonly ModelRowAccount[];
  /** The catalogue in use; null when this daemon has none. */
  readonly catalogue: Catalogue | null;
}

/** The profile that stands for a model's scores: its strongest effort by Intelligence, then Coding. */
function strongestScored(profiles: readonly ModelProfileDto[]): ModelProfileDto | null {
  let best: ModelProfileDto | null = null;
  for (const p of profiles) {
    const { intelligence, coding } = p.scores;
    if (intelligence === null && coding === null) continue;
    if (best === null) {
      best = p;
      continue;
    }
    const gap =
      (intelligence ?? -1) - (best.scores.intelligence ?? -1) ||
      (coding ?? -1) - (best.scores.coding ?? -1);
    if (gap > 0) best = p;
  }
  return best;
}

/**
 * When 10db first saw the model: its earliest profile. A model with no profile (one its runtime cannot run, or
 * one only an account's list names) has nothing to date it by: an account's last read moves on every refresh.
 */
function firstSeen(profiles: readonly ModelProfileDto[]): string | null {
  return profiles.map((p) => p.createdAt).sort()[0] ?? null;
}

/**
 * One row per canonical model: what the maker publishes, joined with where 10db can run it.
 *
 * Every effort's profile and every account offering the model merge into its row, which takes its scores from
 * the strongest scored effort. A model no account offers and that has no status (a seeded alias, or one no
 * account lists any more) is not listed. A model only an account with no list yet is assumed to offer is listed
 * Unknown: that account's own list has not confirmed it. A model an account lists that its runtime cannot run
 * has no profile, and is listed Not runnable.
 */
export function buildModelRows(input: ModelRowsInput): ModelRowDto[] {
  const { catalogue } = input;
  const live = new Map(input.accounts.filter((a) => !a.archived).map((a) => [a.id, a]));
  const offers = input.offers.filter((o) => live.has(o.accountId));
  const listing = new Set(offers.map((o) => o.accountId));
  const withoutList = [...live.values()].filter((a) => !listing.has(a.id));

  const models = [
    ...new Set([...input.profiles.map((p) => p.model), ...offers.map((o) => o.model)]),
  ];
  const rows: ModelRowDto[] = [];
  for (const model of models.sort()) {
    const profiles = input.profiles.filter((p) => p.model === model);
    const offered = offers.filter((o) => o.model === model);
    const described = profiles.find((p) => p.maker !== null) ?? null;
    const providerOfAccount = (id: AccountId): Provider | null => {
      const account = live.get(id);
      return account === undefined ? null : providerOf(account.kind);
    };

    // An account with no list is assumed to run its maker's models that are not retired.
    const assumedEntry: CatalogueModel | null =
      described === null || catalogue === null
        ? null
        : joinModel(model, described.provider, catalogue);
    const assumedOn =
      described !== null &&
      described.maker === RUNTIME_MAKER[described.provider] &&
      assumedEntry !== null &&
      !assumedEntry.deprecated
        ? withoutList.filter((a) => providerOf(a.kind) === described.provider)
        : [];

    const profileStatus = profiles.find((p) => p.status !== null)?.status ?? null;
    if (profileStatus === null && offered.length === 0 && assumedOn.length === 0) continue;

    const refused =
      catalogue !== null &&
      profiles.length === 0 &&
      offered.every((o) => {
        const provider = providerOfAccount(o.accountId);
        return provider !== null && runnability(o.model, provider, catalogue) === 'refused';
      });
    const status = profileStatus ?? (refused ? ModelStatus.NotRunnable : ModelStatus.Unknown);

    const firstOffer = offered[0];
    const lookupProvider =
      described?.provider ?? (firstOffer ? providerOfAccount(firstOffer.accountId) : null);
    const entry =
      catalogue === null || lookupProvider === null
        ? null
        : joinModel(model, lookupProvider, catalogue);

    const available = [
      ...offered.filter((o) => !o.unusable).map((o) => o.accountId),
      ...assumedOn.map((a) => a.id),
    ];
    const availableOn = [...new Set(available)];
    const kinds = new Set(
      availableOn.map((id) => live.get(id)?.kind).filter((k) => k !== undefined),
    );
    const scored = strongestScored(profiles);

    rows.push({
      model,
      name: entry?.name ?? model,
      maker: described?.maker ?? entry?.maker ?? null,
      family: described?.family ?? entry?.family ?? null,
      tier: profiles.find((p) => p.tier !== null)?.tier ?? null,
      status,
      availableOn,
      providers: [...kinds].sort(),
      inputPrice: described?.inputPrice ?? null,
      outputPrice: described?.outputPrice ?? null,
      intelligence: scored?.scores.intelligence ?? null,
      coding: scored?.scores.coding ?? null,
      outputTokensPerSecond:
        scored?.outputTokensPerSecond ??
        profiles.find((p) => p.outputTokensPerSecond !== null)?.outputTokensPerSecond ??
        null,
      stepsRun: profiles.reduce((sum, p) => sum + p.stepsRun, 0),
      firstSeenAt: firstSeen(profiles),
    });
  }
  return rows;
}
