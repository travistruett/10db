import { clampKnowledgeSearch, KNOWLEDGE_SEARCH_MAX_LENGTH, KnowledgeScope } from '@10db/contracts';
import { Group, SegmentedControl, Select, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { isShelf, SHELF_LABELS, type KnowledgeShelf } from './knowledge-shelf';

export interface FilterState {
  readonly scope: KnowledgeScope | null;
  readonly area: string | null;
  readonly q: string;
}

export const NO_FILTERS: FilterState = { scope: null, area: null, q: '' };

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

export interface ShelfChoice {
  readonly shelf: KnowledgeShelf;
  /** How many records wait there, said beside its name; null says nothing. */
  readonly count: number | null;
}

/**
 * One row above a list: the shelf, search and scope on the left, the list's own action (New Principle,
 * New Decision) on the right.
 */
export function KnowledgeToolbar({
  shelves,
  shelf,
  onShelf,
  value,
  areas,
  onChange,
  action,
}: {
  readonly shelves: readonly ShelfChoice[];
  readonly shelf: KnowledgeShelf;
  readonly onShelf: (next: KnowledgeShelf) => void;
  readonly value: FilterState;
  readonly areas: readonly string[];
  readonly onChange: (next: FilterState) => void;
  readonly action: ReactNode;
}) {
  return (
    <Group justify="space-between" align="center" gap="sm" wrap="nowrap">
      <Group align="center" gap="sm" wrap="nowrap">
        <SegmentedControl
          aria-label="Show"
          size="sm"
          value={shelf}
          onChange={(next) => {
            if (isShelf(next)) onShelf(next);
          }}
          data={shelves.map(({ shelf: s, count }) => ({
            value: s,
            label: count ? `${SHELF_LABELS[s]} ${String(count)}` : SHELF_LABELS[s],
          }))}
        />
        <TextInput
          aria-label="Search"
          placeholder="Search"
          size="sm"
          w={240}
          maxLength={KNOWLEDGE_SEARCH_MAX_LENGTH}
          leftSection={<IconSearch size={16} stroke={1.5} />}
          value={value.q}
          onChange={(e) => {
            // maxLength may count graphemes in the Tauri webview (WebKit), so cap in code as well.
            onChange({ ...value, q: clampKnowledgeSearch(e.currentTarget.value) });
          }}
        />
        <Select
          aria-label="Scope"
          size="sm"
          w={160}
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
      </Group>
      {action}
    </Group>
  );
}
