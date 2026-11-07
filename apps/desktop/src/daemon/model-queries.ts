import { AccountModelDto, CatalogueStatusDto, ModelProfileDto, ModelRowDto } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
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
const ProfileList = z.array(ModelProfileDto);

/** One row per model any account can reach. */
export function useModels() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: modelKeys.list,
    queryFn: async () => readJson(await client.models.$get(), ModelRowList),
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

/** Every model and effort with its scores and observed steps. */
export function useModelProfiles() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: modelKeys.profiles,
    queryFn: async () => readJson(await client['model-profiles'].$get(), ProfileList),
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
