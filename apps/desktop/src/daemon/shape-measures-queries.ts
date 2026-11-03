import {
  OneWayPathsDto,
  ShapeJevSettingDto,
  ShapeMeasuresDto,
  type ProjectId,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';
import { shapeKeys } from './shape-queries';

// Shape spec §8 and §9: the Sizing hit rate and the shadow agreement Settings › Decisions shows, and a
// project's "Send brainstorm messages to fast models".

export const shapeMeasureKeys = {
  measures: ['shape', 'measures'],
  jev: (projectId: ProjectId) => ['shape', 'jev', projectId],
  oneWay: (projectId: ProjectId) => ['shape', 'one-way-paths', projectId],
} as const;

/** Shape spec §7: the globs that make a task one-way, which force a spec for its effort. */
export function useOneWayPaths(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: shapeMeasureKeys.oneWay(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['one-way-paths'].$get({ param: { projectId } }),
        OneWayPathsDto,
      ),
  });
}

export function useSetOneWayPaths(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (paths: readonly string[]) =>
      readJson(
        await client.projects[':projectId']['one-way-paths'].$put({
          param: { projectId },
          json: { paths: [...paths] },
        }),
        OneWayPathsDto,
      ),
    onSuccess: (setting) => {
      queryClient.setQueryData(shapeMeasureKeys.oneWay(projectId), setting);
      // The daemon works a conversation's ceremony out from these paths and emits no event when they
      // change, so an open conversation asks again.
      void queryClient.invalidateQueries({ queryKey: shapeKeys.all });
    },
  });
}

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
