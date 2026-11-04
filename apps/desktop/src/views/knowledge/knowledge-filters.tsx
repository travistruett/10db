import { KnowledgeScope } from '@10db/contracts';
import { Group, Select, Switch, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';

export interface FilterState {
  readonly scope: KnowledgeScope | null;
  readonly area: string | null;
  readonly q: string;
  readonly history: boolean;
}

export const NO_FILTERS: FilterState = { scope: null, area: null, q: '', history: false };

const ALL = 'all';
const AREA_PREFIX = 'area:';

/** The one select holds You, Project and each area, so "one area" is a choice like the others. */
function scopeValue(f: FilterState): string {
  if (f.scope === KnowledgeScope.Area && f.area !== null) return `${AREA_PREFIX}${f.area}`;
  return f.scope ?? ALL;
}

function scopeFrom(value: string | null): Pick<FilterState, 'scope' | 'area'> {
  if (value === KnowledgeScope.You) return { scope: KnowledgeScope.You, area: null };
  if (value === KnowledgeScope.Project) return { scope: KnowledgeScope.Project, area: null };
  if (value?.startsWith(AREA_PREFIX))
    return { scope: KnowledgeScope.Area, area: value.slice(AREA_PREFIX.length) };
  return { scope: null, area: null };
}

/** Search, scope and History for the Principles and Decisions tabs. */
export function KnowledgeFilters({
  value,
  areas,
  historyDisabled,
  onChange,
}: {
  readonly value: FilterState;
  readonly areas: readonly string[];
  /** Pending proposals have no history. */
  readonly historyDisabled: boolean;
  readonly onChange: (next: FilterState) => void;
}) {
  return (
    <Group align="center" gap="sm">
      <TextInput
        aria-label="Search"
        placeholder="Search"
        size="sm"
        w={260}
        leftSection={<IconSearch size={16} stroke={1.5} />}
        value={value.q}
        onChange={(e) => {
          onChange({ ...value, q: e.currentTarget.value });
        }}
      />
      <Select
        aria-label="Scope"
        size="sm"
        w={180}
        allowDeselect={false}
        checkIconPosition="right"
        data={[
          { value: ALL, label: 'All scopes' },
          { value: KnowledgeScope.You, label: 'You' },
          { value: KnowledgeScope.Project, label: 'Project' },
          ...areas.map((name) => ({ value: `${AREA_PREFIX}${name}`, label: name })),
        ]}
        value={scopeValue(value)}
        onChange={(next) => {
          onChange({ ...value, ...scopeFrom(next) });
        }}
      />
      <Switch
        label="History"
        disabled={historyDisabled}
        checked={value.history}
        onChange={(e) => {
          onChange({ ...value, history: e.currentTarget.checked });
        }}
      />
    </Group>
  );
}
