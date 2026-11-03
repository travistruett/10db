import { ShapeJevSettingDto, ShapeMeasuresDto, type ProjectId } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

// Shape spec §8 and §9: the Sizing hit rate and the shadow agreement Settings › Decisions shows, and a
// project's "Send brainstorm messages to fast models".

export const shapeMeasureKeys = {
  measures: ['shape', 'measures'],
  jev: (projectId: ProjectId) => ['shape', 'jev', projectId],
} as const;

export function useShapeMeasures() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: shapeMeasureKeys.measures,
    queryFn: async () => readJson(await client['shape-measures'].$get(), ShapeMeasuresDto),
    refetchOnWindowFocus: 'always',
  });
}

export function useShapeJev(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: shapeMeasureKeys.jev(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['shape-jev'].$get({ param: { projectId } }),
        ShapeJevSettingDto,
      ),
  });
}

export function useSetShapeJev(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) =>
      readJson(
        await client.projects[':projectId']['shape-jev'].$put({
          param: { projectId },
          json: { enabled },
        }),
        ShapeJevSettingDto,
      ),
    onSuccess: (setting) => {
      queryClient.setQueryData(shapeMeasureKeys.jev(projectId), setting);
    },
  });
}
