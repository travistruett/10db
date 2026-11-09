import {
  DECISION_CATEGORIES,
  InboxKind,
  KnowledgeScope,
  type DecisionRecording,
  type InboxItemDto,
} from '@10db/contracts';
import { Checkbox, Group, Select } from '@mantine/core';
import { useProjects } from '../../daemon/queries';
import { SCOPE_ALL_PROJECTS, SCOPE_THIS_PROJECT } from '../knowledge/knowledge-labels';

const AREA_PREFIX = 'area:';

/** The daemon's own default (spec §7): product, design and engineering answers are project decisions. */
export function defaultRecording(item: InboxItemDto): DecisionRecording | null {
  if (item.kind !== InboxKind.Question) return null;
  return DECISION_CATEGORIES.includes(item.category)
    ? { scope: KnowledgeScope.Project, area: null }
    : null;
}

const valueOf = (r: DecisionRecording): string =>
  r.scope === KnowledgeScope.Area && r.area !== null ? `${AREA_PREFIX}${r.area}` : r.scope;

function recordingOf(value: string): DecisionRecording {
  if (value.startsWith(AREA_PREFIX))
    return { scope: KnowledgeScope.Area, area: value.slice(AREA_PREFIX.length) };
  return value === KnowledgeScope.You
    ? { scope: KnowledgeScope.You, area: null }
    : { scope: KnowledgeScope.Project, area: null };
}

/** Whether the answer is recorded as a decision, and for whom: a checkbox and, when checked, a scope. */
export function RecordDecision({
  item,
  value,
  onChange,
}: {
  readonly item: InboxItemDto;
  readonly value: DecisionRecording | null;
  readonly onChange: (next: DecisionRecording | null) => void;
}) {
  const areas = useProjects().data?.find((p) => p.id === item.projectId)?.areas ?? [];
  return (
    <Group gap="sm" align="flex-end">
      <Checkbox
        label="Record as a decision"
        checked={value !== null}
        onChange={(e) => {
          onChange(e.currentTarget.checked ? { scope: KnowledgeScope.Project, area: null } : null);
        }}
      />
      {value !== null ? (
        <Select
          aria-label="Decision applies to"
          size="sm"
          w={220}
          allowDeselect={false}
          data={[
            { value: KnowledgeScope.Project, label: SCOPE_THIS_PROJECT },
            { value: KnowledgeScope.You, label: SCOPE_ALL_PROJECTS },
            ...areas.map((a) => ({ value: `${AREA_PREFIX}${a.name}`, label: `Area: ${a.name}` })),
          ]}
          value={valueOf(value)}
          onChange={(next) => {
            if (next !== null) onChange(recordingOf(next));
          }}
        />
      ) : null}
    </Group>
  );
}
