import { SessionsSettingsDto } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

// Settings › Sessions: whether a chat's reply notifies while the window is behind another app.

export const sessionsSettingsKey = ['settings', 'sessions'] as const;

export function useSessionsSettings() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: sessionsSettingsKey,
    queryFn: async () => readJson(await client.settings.sessions.$get(), SessionsSettingsDto),
  });
}

export function useSetSessionsSettings() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (settings: SessionsSettingsDto) =>
      readJson(await client.settings.sessions.$put({ json: settings }), SessionsSettingsDto),
    onSuccess: (settings) => {
      queryClient.setQueryData(sessionsSettingsKey, settings);
    },
  });
}
