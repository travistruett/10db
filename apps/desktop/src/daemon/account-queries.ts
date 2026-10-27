import { AccountDto } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

/** Query keys for accounts; an `account` event invalidates the whole `['accounts']` prefix. */
export const accountKeys = {
  all: ['accounts'],
} as const;

const AccountList = z.array(AccountDto);

export function useAccounts() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: accountKeys.all,
    queryFn: async () => readJson(await client.accounts.$get(), AccountList),
  });
}
