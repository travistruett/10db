import {
  AccountConnectDto,
  AccountConnectingDto,
  AccountCreatedDto,
  AccountDto,
  AccountIdentityDto,
  AccountPauseDto,
  AccountSignInDto,
  AccountUsageDto,
  type AccountId,
  type AccountLoginEndedData,
  type AccountConfig,
  type AccountPatch,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { openSignInPage } from '../desktop/tauri';
import { readJson } from './client';
import { useDaemon } from './provider';
import { queryKeys } from './queries';

/**
 * Query keys for accounts; an `account` event invalidates the whole `['accounts']` prefix. Usage sits
 * under it, so a cap change refreshes usage too.
 */
export const accountKeys = {
  all: ['accounts'],
  pauses: ['accounts', 'pauses'],
  connecting: ['accounts', 'connecting'],
  usage: ['accounts', 'usage'],
  usageOf: (id: AccountId) => ['accounts', 'usage', id] as const,
  signInOf: (id: AccountId) => ['accounts', 'signin', id] as const,
} as const;

/**
 * Where the end of an account's browser sign-in is kept for the drawer: the `account.login_ended` event
 * writes it. It sits outside `['accounts']`, which every account event refetches, because nothing
 * can refetch it.
 */
export const accountLoginKey = (id: AccountId) => ['account-login', id] as const;

const AccountList = z.array(AccountDto);
const AccountPauseList = z.array(AccountPauseDto);

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
    queryKey: accountKeys.signInOf(id),
    queryFn: async () =>
      readJson(
        await client.accounts[':accountId'].signin.$get({ param: { accountId: id } }),
        AccountSignInDto,
      ),
    enabled,
  });
}

/** The accounts paused now; `account.paused` and `account.resumed` events refresh it with the rest. */
export function useAccountPauses() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: accountKeys.pauses,
    queryFn: async () => readJson(await client.accounts.pauses.$get(), AccountPauseList),
  });
}

/** Lifts a refused or monthly-cap pause, as saving the account unchanged does. */
export function useResumeAccount() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: AccountId) =>
      readJson(
        await client.accounts[':accountId'].resume.$post({ param: { accountId: id } }),
        AccountPauseList,
      ),
    // The workstreams and the inbox follow from the daemon's events.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountKeys.all }),
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

/** How the account's browser sign-in last ended, or null while none has since the builder last clicked Connect. */
export function useAccountLoginEnd(id: AccountId) {
  return useQuery<AccountLoginEndedData | null>({
    queryKey: accountLoginKey(id),
    queryFn: () => null,
    initialData: null,
    enabled: false,
  }).data;
}

/**
 * The account whose browser sign-in holds the daemon's one slot, or null. The daemon owns it, so a drawer
 * opened later, or after a restart, shows the true state; every account event and every reconnect of the
 * event stream refetches it.
 */
export function useConnectingAccount() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: accountKeys.connecting,
    queryFn: async () =>
      readJson(await client.accounts.connecting.$get(), AccountConnectingDto.nullable()),
  });
}

/**
 * Starts the account's browser sign-in and opens the page the daemon names, if it names one. Opening is
 * part of the mutation, not of a component's callback, so it still happens when the drawer was closed
 * before the daemon answered. A page that will not open ends the sign-in again and fails with that
 * reason. The end of a sign-in that did start arrives as an event.
 */
export function useConnectAccount() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: AccountId) => {
      queryClient.setQueryData(accountLoginKey(id), null);
      const started = await readJson(
        await client.accounts[':accountId'].connect.$post({ param: { accountId: id } }),
        AccountConnectDto,
      );
      if (started.authUrl !== null) {
        try {
          await openSignInPage(started.authUrl);
        } catch {
          // The sign-in would wait for a page nobody can see: end it before saying why.
          await client.accounts[':accountId'].connect.$delete({ param: { accountId: id } });
          await queryClient.invalidateQueries({ queryKey: accountKeys.connecting });
          throw new Error('The browser did not open. Try Connect again, or sign in from Terminal.');
        }
      }
      // Pending until the slot is read, so the button never flashes back before the wait shows.
      await queryClient.invalidateQueries({ queryKey: accountKeys.connecting });
      return started;
    },
    onError: () => queryClient.invalidateQueries({ queryKey: accountKeys.connecting }),
  });
}

/** Abandons an account's waiting browser sign-in. */
export function useCancelConnect() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: AccountId) => {
      // The answer is 204 with no body; a refusal throws with the daemon's message.
      await readJson(
        await client.accounts[':accountId'].connect.$delete({ param: { accountId: id } }),
        z.unknown(),
      );
      await queryClient.invalidateQueries({ queryKey: accountKeys.connecting });
    },
  });
}
