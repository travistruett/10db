import { ModelSettingsDto, type ModelSettingsInput, type ProjectId } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

/** Every role-setting and pattern query; a `role_setting` or `pattern` event refetches them all. */
export const modelSettingKeys = {
  all: ['model-settings'] as const,
  scope: (projectId: ProjectId | null) => ['model-settings', projectId ?? 'all'] as const,
};

/** The role settings and patterns of one project, or of everywhere for null. */
export function useModelSettings(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: modelSettingKeys.scope(projectId),
    queryFn: async () =>
      readJson(
        projectId === null
          ? await client['model-settings'].$get()
          : await client.projects[':projectId']['model-settings'].$get({ param: { projectId } }),
        ModelSettingsDto,
      ),
  });
}

/** Sets roles or replaces the patterns that apply everywhere. */
export function useSetGlobalModelSettings() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ModelSettingsInput) =>
      readJson(await client['model-settings'].$put({ json: input }), ModelSettingsDto),
    onSuccess: (saved) => {
      queryClient.setQueryData(modelSettingKeys.scope(null), saved);
    },
  });
}

/** Sets roles or replaces the patterns of one project; a null role setting hands the role back to the global one. */
export function useSetProjectModelSettings(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ModelSettingsInput) =>
      readJson(
        await client.projects[':projectId']['model-settings'].$put({
          param: { projectId },
          json: input,
        }),
        ModelSettingsDto,
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(modelSettingKeys.scope(projectId), saved);
    },
  });
}
