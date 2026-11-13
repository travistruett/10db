import { GithubSigninDto, GithubStatusDto, type GithubLoginEndedData } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { openSignInPage } from '../desktop/tauri';
import { useRenderMode } from '../screens/render-context';
import { readJson } from './client';
import { useDaemon } from './provider';

export const githubKeys = {
  status: ['github', 'status'],
  /** How the last Sign In ended; written by the event stream, never fetched. */
  loginEnd: ['github', 'login-end'],
} as const;

/**
 * gh's login as the daemon last probed it, with the code and page of a Sign In that waits for the builder, so
 * a card mounted mid-sign-in shows them. A screen's frame never asks: its token may not read `/github`.
 */
export function useGithubStatus() {
  const { client } = useDaemon();
  const frame = useRenderMode() !== null;
  return useQuery({
    queryKey: githubKeys.status,
    enabled: !frame,
    queryFn: async () => readJson(await client.github.$get({ query: {} }), GithubStatusDto),
  });
}

/** Looks for gh and its login again (`GET /github?recheck=1`) and replaces the status with the answer. */
export function useRecheckGithub() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      readJson(await client.github.$get({ query: { recheck: '1' } }), GithubStatusDto),
    onSuccess: (status) => {
      queryClient.setQueryData(githubKeys.status, status);
    },
  });
}

/**
 * Starts gh's browser sign-in and opens the page it names. A page that will not open leaves the sign-in
 * running with its code on screen, and the result says so. The end of a sign-in arrives as an event.
 */
export function useStartGithubSignin() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      queryClient.setQueryData(githubKeys.loginEnd, null);
      const signin = await readJson(await client.github.signin.$post(), GithubSigninDto);
      let opened = true;
      try {
        await openSignInPage(signin.url);
      } catch {
        opened = false;
      }
      // Pending until the status carries the code, so the button never flashes back before the wait shows.
      await queryClient.invalidateQueries({ queryKey: githubKeys.status });
      return { signin, opened };
    },
    onError: () => queryClient.invalidateQueries({ queryKey: githubKeys.status }),
  });
}

/** Stops the waiting sign-in. */
export function useCancelGithubSignin() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // The answer is 204 with no body; a refusal throws with the daemon's message.
      await readJson(await client.github.signin.$delete(), z.unknown());
      await queryClient.invalidateQueries({ queryKey: githubKeys.status });
    },
  });
}

/** How the last Sign In ended, or null while none has since the builder last pressed Sign In. */
export function useGithubLoginEnd() {
  return useQuery<GithubLoginEndedData | null>({
    queryKey: githubKeys.loginEnd,
    queryFn: () => null,
    initialData: null,
    enabled: false,
  }).data;
}
