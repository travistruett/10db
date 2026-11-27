import type { PutSharingBody } from '@10db/contracts';
import { SharingStatusDto } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

export const sharingKeys = { all: ['sharing'] as const };

/** The page re-reads Tailscale this often while it is open; the daemon's `sharing.changed` event refetches sooner. */
export const SHARING_POLL_MS = 10_000;

/** Sharing this Mac: each step read live from Tailscale. */
export function useSharing() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: sharingKeys.all,
    queryFn: async () => readJson(await client.sharing.$get(), SharingStatusDto),
  });
}

/** `useSharing` that also re-reads on a timer; only the Remote Access page uses it. */
export function useSharingPolled() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: sharingKeys.all,
    queryFn: async () => readJson(await client.sharing.$get(), SharingStatusDto),
    refetchInterval: SHARING_POLL_MS,
  });
}

/** Share, Stop Sharing or Change Port; a refusal arrives as the mutation's error, in the daemon's words. */
export function useSetSharing() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    // An action, not a saved setting: a settings page's bar does not say Saved for it.
    meta: { quiet: true },
    mutationFn: async (body: PutSharingBody) =>
      readJson(await client.sharing.$put({ json: body }), SharingStatusDto),
    onSuccess: (status) => queryClient.setQueryData(sharingKeys.all, status),
  });
}

/** Get Certificate: writes the Mac's name to public certificate logs, so only a button press asks for it. */
export function useRequestCertificate() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    meta: { quiet: true },
    mutationFn: async () => readJson(await client.sharing.certificate.$post(), SharingStatusDto),
    onSuccess: (status) => queryClient.setQueryData(sharingKeys.all, status),
  });
}

/** Turn on Tailscale: the daemon runs `tailscale up`; a sign-in it waits on arrives as the error, in the CLI's words. */
export function useConnectTailscale() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    meta: { quiet: true },
    mutationFn: async () => readJson(await client.sharing.connect.$post(), SharingStatusDto),
    onSuccess: (status) => queryClient.setQueryData(sharingKeys.all, status),
  });
}
