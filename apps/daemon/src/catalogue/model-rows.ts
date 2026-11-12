import {
  providerOf,
  Effort,
  ModelStatus,
  type AccountDto,
  type AccountId,
  type AccountModelDto,
  type ModelEffortDto,
  type ModelProfileDto,
  type ModelRowDto,
  type Provider,
} from '@10db/contracts';
import { costOnAccount, offeredProfiles } from '../routing';
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
  /**
   * The account the costs are for. A model it offers lists only the efforts it offers, priced on it; any other
   * model keeps every effort at the maker's cost. Without one, costs are the maker's.
   */
  readonly account?: ModelRowAccount;
}

const EFFORT_ORDER: readonly Effort[] = Object.values(Effort);
const effortLevel = (effort: Effort): number => EFFORT_ORDER.indexOf(effort);

/**
 * A model's efforts, strongest Intelligence first. Equal scores go to the cheaper effort, then the higher one;
 * unscored efforts come last, highest effort first.
 */
function listEfforts(
  profiles: readonly ModelProfileDto[],
  accountModels: readonly AccountModelDto[] | undefined,
): ModelEffortDto[] {
  const withCost = profiles.map((p) => ({ p, cost: costOnAccount(p, accountModels) }));
  withCost.sort((a, b) => {
    const x = a.p.scores.intelligence;
    const y = b.p.scores.intelligence;
    if (x === null || y === null) {
      if (x !== null) return -1;
      if (y !== null) return 1;
      return effortLevel(b.p.effort) - effortLevel(a.p.effort);
    }
    return (
      y - x ||
      (a.cost ?? Infinity) - (b.cost ?? Infinity) ||
      effortLevel(b.p.effort) - effortLevel(a.p.effort)
    );
  });
  return withCost.map(({ p, cost }) => ({
    profileId: p.id,
    effort: p.effort,
    intelligence: p.scores.intelligence,
    costPerTaskUsd: cost,
    outputTokensPerSecond: p.outputTokensPerSecond,
    stepsRun: p.stepsRun,
    firstPassSteps: p.firstPassSteps,
  }));
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
    const { account } = input;
    const accountOffers = account
      ? input.offers.filter((o) => o.accountId === account.id)
      : undefined;
    const accountProvider = account ? providerOf(account.kind) : undefined;
    const offeredToAccount =
      accountOffers !== undefined &&
      (accountOffers.length === 0
        ? profiles.some((p) => p.provider === accountProvider)
        : accountOffers.some((o) => o.model === model && !o.unusable));
    const efforts = listEfforts(
      offeredToAccount && accountProvider !== undefined
        ? offeredProfiles(profiles, accountOffers, accountProvider)
        : profiles,
      accountOffers,
    );
    const first = efforts[0];

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
      intelligence: first?.intelligence ?? null,
      costPerTaskUsd: first?.costPerTaskUsd ?? null,
      outputTokensPerSecond:
        first?.outputTokensPerSecond ??
        profiles.find((p) => p.outputTokensPerSecond !== null)?.outputTokensPerSecond ??
        null,
      efforts,
      stepsRun: profiles.reduce((sum, p) => sum + p.stepsRun, 0),
      firstSeenAt: firstSeen(profiles),
    });
  }
  return rows;
}
