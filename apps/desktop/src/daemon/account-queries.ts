import {
  AccountCreatedDto,
  AccountDto,
  AccountIdentityDto,
  AccountSignInDto,
  AccountUsageDto,
  type AccountId,
  type AccountConfig,
  type AccountPatch,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';
import { queryKeys } from './queries';

/**
 * Query keys for accounts; an `account` event invalidates the whole `['accounts']` prefix. Usage sits
 * under it, so a cap change refreshes usage too.
 */
export const accountKeys = {
  all: ['accounts'],
  usage: ['accounts', 'usage'],
  usageOf: (id: AccountId) => ['accounts', 'usage', id] as const,
} as const;

const AccountList = z.array(AccountDto);

export function useAccounts() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: accountKeys.all,
    queryFn: async () => readJson(await client.accounts.$get(), AccountList),
  });
}

/** This month's usage on the account: the daemon's current month. */
export function useAccountUsage(id: AccountId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: accountKeys.usageOf(id),
    queryFn: async () =>
      readJson(
        await client.accounts[':accountId'].usage.$get({ param: { accountId: id }, query: {} }),
        AccountUsageDto,
      ),
  });
}

/** How to sign a subscription in; asked for only when the account is a subscription. */
export function useAccountSignIn(id: AccountId, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...accountKeys.all, 'signin', id] as const,
    queryFn: async () =>
      readJson(
        await client.accounts[':accountId'].signin.$get({ param: { accountId: id } }),
        AccountSignInDto,
      ),
    enabled,
  });
}

export function useCreateAccount() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AccountConfig) =>
      readJson(await client.accounts.$post({ json: input }), AccountCreatedDto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountKeys.all }),
  });
}

export function usePatchAccount(id: AccountId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: AccountPatch) =>
      readJson(
        await client.accounts[':accountId'].$patch({ param: { accountId: id }, json: patch }),
        AccountDto,
      ),
    // Project pickers show account labels.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: accountKeys.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
      ]),
  });
}

export function useArchiveAccount() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: AccountId) =>
      readJson(
        await client.accounts[':accountId'].archive.$post({ param: { accountId: id } }),
        AccountDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountKeys.all }),
  });
}

/**
 * What Claude Code reports for the account now. A mutation, not a query: the probe starts Claude Code,
 * so it runs only when the builder asks.
 */
export function useCheckAccountIdentity() {
  const { client } = useDaemon();
  return useMutation({
    mutationFn: async (id: AccountId) =>
      readJson(
        await client.accounts[':accountId'].identity.$get({ param: { accountId: id } }),
        AccountIdentityDto,
      ),
  });
}
