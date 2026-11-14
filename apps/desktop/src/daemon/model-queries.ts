import {
  AccountModelDto,
  CatalogueStatusDto,
  ModelMeasuresDto,
  ModelRowDto,
  RIGORS,
  RolePicksDto,
  type AccountId,
  type ProjectId,
  type Rigor,
} from '@10db/contracts';
import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import { readJson, type DaemonClient } from './client';
import { useDaemon } from './provider';

/** Every model query; the event stream refetches them all when a profile or an account's list changes. */
export const modelKeys = {
  all: ['models'] as const,
  list: ['models', 'list'] as const,
  offers: ['models', 'offers'] as const,
  status: ['models', 'status'] as const,
  profiles: ['models', 'profiles'] as const,
};

const ModelRowList = z.array(ModelRowDto);
const OfferList = z.array(AccountModelDto);

/**
 * One row per model any account can reach; `enabled` false waits for the account to be known. With an account, a model it offers lists its efforts, costed on it;
 * the previous rows stay up while another account's load.
 */
export function useModels(accountId: AccountId | null, enabled = true) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...modelKeys.list, accountId],
    enabled,
    queryFn: async () =>
      readJson(
        await client.models.$get({ query: accountId === null ? {} : { account: accountId } }),
        ModelRowList,
      ),
    placeholderData: keepPreviousData,
  });
}

function picksQuery(
  client: DaemonClient,
  accountId: AccountId | null,
  rigor: Rigor,
  projectId: ProjectId | null,
) {
  return {
    queryKey: [...modelKeys.all, 'picks', accountId, rigor, projectId ?? 'all'],
    enabled: accountId !== null,
    queryFn: async () =>
      readJson(
        await client.models.picks.$get({
          query: {
            account: accountId ?? '',
            rigor,
            ...(projectId === null ? {} : { project: projectId }),
          },
        }),
        RolePicksDto,
      ),
  };
}

/**
 * What routing chooses for each role on the account at one rigor's cells, in a project's playbook or the
 * global one for null; off until an account is chosen.
 */
export function useModelPicks(
  accountId: AccountId | null,
  rigor: Rigor,
  projectId: ProjectId | null,
) {
  const { client } = useDaemon();
  return useQuery(picksQuery(client, accountId, rigor, projectId));
}

/** The picks of every rigor, for the playbook table; each shares its cache entry with `useModelPicks`. */
export function useEveryRigorPicks(accountId: AccountId | null, projectId: ProjectId | null) {
  const { client } = useDaemon();
  const results = useQueries({
    queries: RIGORS.map((rigor) => picksQuery(client, accountId, rigor, projectId)),
  });
  return new Map(RIGORS.map((rigor, i) => [rigor, results[i]]));
}

/**
 * The OpenRouter rows stored for one model, with the provider the account's speed is measured on; off until a
 * model is named.
 */
export function useModelMeasures(model: string | null, account: AccountId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...modelKeys.all, 'measures', model, account],
    enabled: model !== null,
    queryFn: async () =>
      readJson(
        await client.models.measures.$get({
          query: { model: model ?? '', ...(account === null ? {} : { account }) },
        }),
        ModelMeasuresDto,
      ),
  });
}

/** What each account offers: its launch ID and its own price. */
export function useModelOffers() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: modelKeys.offers,
    queryFn: async () => readJson(await client.models.offers.$get(), OfferList),
  });
}

/** Where the catalogue came from and when. */
export function useCatalogueStatus() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: modelKeys.status,
    queryFn: async () => readJson(await client.models.status.$get(), CatalogueStatusDto),
  });
}

/** Fetches the catalogue and reads every account's list now; the daemon joins a refresh already running. */
export function useRefreshModels() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => readJson(await client.models.refresh.$post(), CatalogueStatusDto),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: modelKeys.all });
    },
  });
}
