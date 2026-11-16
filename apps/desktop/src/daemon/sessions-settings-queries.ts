import { SessionsSettingsDto, type SessionsSettingsPatch } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

// Settings › Sessions: whether a chat's reply notifies while the window is behind another app, and where Open in
// Terminal opens a chat.

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
    // A change names only what it sets, so one control never writes the other's value back.
    mutationFn: async (change: SessionsSettingsPatch) =>
      readJson(await client.settings.sessions.$patch({ json: change }), SessionsSettingsDto),
    onSuccess: (settings) => {
      queryClient.setQueryData(sessionsSettingsKey, settings);
    },
  });
}
