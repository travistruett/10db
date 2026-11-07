import type { ModelSettingsDto, ProjectId, ProjectModelSettingsInput } from '@10db/contracts';
import {
  clearRoleSetting,
  getProject,
  listPatterns,
  listRoleSettings,
  setPatterns,
  setRoleSetting,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { ApiServices } from '../api';
import type { StateStore } from '../events';

/** The settings of one scope as the HTTP API reads them: a project's own rows, or the global ones. */
export type ModelSettingsApiServices = Pick<
  ApiServices,
  'getModelSettings' | 'setGlobalModelSettings' | 'setProjectModelSettings'
>;

function readScope(db: DbReader, projectId: ProjectId | null): ModelSettingsDto {
  return {
    roles: listRoleSettings(db).filter((r) => r.projectId === projectId),
    patterns: listPatterns(db).filter((p) => p.projectId === projectId),
  };
}

function writeScope(
  ctx: WriteContext,
  projectId: ProjectId | null,
  input: ProjectModelSettingsInput,
): ModelSettingsDto {
  for (const { role, setting } of input.roles) {
    if (setting === null) clearRoleSetting(ctx, role, projectId);
    else setRoleSetting(ctx, { role, projectId, setting });
  }
  if (input.patterns !== undefined) setPatterns(ctx, projectId, input.patterns);
  return readScope(ctx.tx, projectId);
}

export function createModelSettingsServices(state: StateStore): ModelSettingsApiServices {
  return {
    getModelSettings: (projectId) => {
      // A missing project is a 404, not an empty list.
      if (projectId !== null) getProject(state.db, projectId);
      return readScope(state.db, projectId);
    },
    setGlobalModelSettings: (input) => state.write((ctx) => writeScope(ctx, null, input)),
    setProjectModelSettings: (projectId, input) =>
      state.write((ctx) => {
        getProject(ctx.tx, projectId);
        return writeScope(ctx, projectId, input);
      }),
  };
}
