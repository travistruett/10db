import {
  hazardScope,
  HazardScope,
  type AreaDef,
  type HazardDef,
  type ProjectDto,
} from '@10db/contracts';
import { roleFields, type RoleChoice } from './area-role-fields';

/** An area as the drawer's fields hold it. */
export interface AreaDraft {
  readonly name: string;
  readonly paths: string;
  /** The project's catch-all: a file no other area holds falls in it. At most one area. */
  readonly catchAll: boolean;
  readonly role: RoleChoice;
  /** A page's route; kept while the role changes, sent only for a page. */
  readonly route: string;
  /** A page's label; kept while the role changes, sent only for a page. */
  readonly label: string;
}

/** A hazard as the drawer's fields hold it. */
export interface HazardDraft {
  readonly name: string;
  readonly paths: string;
  readonly perCopy: boolean;
  readonly commands: string;
}

export const EMPTY_AREA: AreaDraft = {
  name: '',
  paths: '',
  catchAll: false,
  role: '',
  route: '',
  label: '',
};

export const EMPTY_HAZARD: HazardDraft = { name: '', paths: '', commands: '', perCopy: false };

export const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

type StoredArea = ProjectDto['areas'][number];
type StoredHazard = ProjectDto['hazards'][number];

export const areaDraft = (area: StoredArea): AreaDraft => ({
  name: area.name,
  paths: area.globs.join('\n'),
  catchAll: area.catchAll === true,
  role: area.role ?? '',
  route: area.route ?? '',
  label: area.label ?? '',
});

export const hazardDraft = (hazard: StoredHazard): HazardDraft => ({
  name: hazard.name,
  paths: hazard.globs.join('\n'),
  commands: hazard.commands.join('\n'),
  perCopy: hazardScope(hazard) === HazardScope.Copy,
});

/** The area a draft stands for, as a project stores it. */
export const areaOf = (draft: AreaDraft): AreaDef => ({
  name: draft.name.trim(),
  globs: lines(draft.paths),
  ...(draft.catchAll ? { catchAll: true } : {}),
  ...roleFields(draft.role, draft.route, draft.label),
});

/** The hazard a draft stands for, as a project stores it. */
export const hazardOf = (draft: HazardDraft): HazardDef => ({
  name: draft.name.trim(),
  globs: lines(draft.paths),
  commands: lines(draft.commands),
  scope: draft.perCopy ? HazardScope.Copy : HazardScope.Project,
});
