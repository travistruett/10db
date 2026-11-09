import {
  KnowledgeScope,
  type KnowledgeTarget,
  type ProjectId,
  type ProjectViewDto,
} from '@10db/contracts';
import { Select } from '@mantine/core';
import { SCOPE_ALL_PROJECTS, SCOPE_THIS_PROJECT } from './knowledge-labels';
import { areaScopeLabel, scopeAreas } from './knowledge-areas';

const AREA_PREFIX = 'area:';

function targetValue(target: KnowledgeTarget): string {
  switch (target.scope) {
    case KnowledgeScope.You:
      return KnowledgeScope.You;
    case KnowledgeScope.Project:
      return KnowledgeScope.Project;
    case KnowledgeScope.Area:
      return `${AREA_PREFIX}${target.area}`;
  }
}

function targetFrom(value: string, projectId: ProjectId): KnowledgeTarget {
  if (value === KnowledgeScope.You) return { scope: KnowledgeScope.You };
  if (value.startsWith(AREA_PREFIX))
    return { scope: KnowledgeScope.Area, projectId, area: value.slice(AREA_PREFIX.length) };
  return { scope: KnowledgeScope.Project, projectId };
}

/** The target a stored record has, in the selected project. */
export function recordTarget(
  record: { readonly scope: KnowledgeScope; readonly area: string | null },
  projectId: ProjectId,
): KnowledgeTarget {
  switch (record.scope) {
    case KnowledgeScope.You:
      return { scope: KnowledgeScope.You };
    case KnowledgeScope.Project:
      return { scope: KnowledgeScope.Project, projectId };
    case KnowledgeScope.Area:
      return record.area === null
        ? { scope: KnowledgeScope.Project, projectId }
        : { scope: KnowledgeScope.Area, projectId, area: record.area };
  }
}

/** The place a write names: the routes take a scope and an area, and the project comes from the URL or the record. */
export function placeOf(target: KnowledgeTarget): {
  readonly scope: KnowledgeScope;
  readonly area?: string;
} {
  return target.scope === KnowledgeScope.Area
    ? { scope: target.scope, area: target.area }
    : { scope: target.scope };
}

/** Where a record applies: all projects, the project, or one of its areas. */
export function TargetSelect({
  project,
  value,
  onChange,
}: {
  readonly project: ProjectViewDto;
  readonly value: KnowledgeTarget;
  readonly onChange: (target: KnowledgeTarget) => void;
}) {
  return (
    <Select
      label="Applies to"
      allowDeselect={false}
      checkIconPosition="right"
      data={[
        { value: KnowledgeScope.Project, label: `${SCOPE_THIS_PROJECT} (${project.name})` },
        { value: KnowledgeScope.You, label: SCOPE_ALL_PROJECTS },
        ...scopeAreas(project.areas).map((name) => ({
          value: `${AREA_PREFIX}${name}`,
          label: areaScopeLabel(name),
        })),
      ]}
      value={targetValue(value)}
      onChange={(next) => {
        if (next !== null) onChange(targetFrom(next, project.id));
      }}
    />
  );
}
