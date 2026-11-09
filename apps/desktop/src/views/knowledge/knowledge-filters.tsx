import { clampKnowledgeSearch, KNOWLEDGE_SEARCH_MAX_LENGTH, KnowledgeScope } from '@10db/contracts';
import { SegmentedControl, Select, Stack, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { SCOPE_ALL_PROJECTS, SCOPE_THIS_PROJECT } from './knowledge-labels';
import { isShelf, KnowledgeShelf, SHELF_LABELS } from './knowledge-shelf';
import { areaScopeLabel } from './knowledge-areas';

export interface FilterState {
  readonly scope: KnowledgeScope | null;
  readonly area: string | null;
  readonly q: string;
}

export const NO_FILTERS: FilterState = { scope: null, area: null, q: '' };

const ALL = 'all';
const AREA_PREFIX = 'area:';

/** The one select holds All projects, This project and each area, so "one area" is a choice like the others. */
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
 * What a list's filters are and how to change them. The first column's filter holds the shelf and the
 * search, the Scope column's filter the scope; both tabs share the search and the scope.
 */
export interface ListControls {
  readonly shelves: readonly ShelfChoice[];
  readonly shelf: KnowledgeShelf;
  readonly onShelf: (next: KnowledgeShelf) => void;
  readonly filters: FilterState;
  readonly areas: readonly string[];
  readonly onFilters: (next: FilterState) => void;
}

/** Whether the first column's filter narrows the list: a shelf other than Current, or a search. */
export function firstColumnFiltering(c: ListControls): boolean {
  return c.shelf !== KnowledgeShelf.Current || c.filters.q.trim() !== '';
}

/** The first column's filter: which shelf, and the search. */
export function ShelfSearchFilter({ controls }: { readonly controls: ListControls }) {
  const { shelves, shelf, onShelf, filters, onFilters } = controls;
  return (
    <Stack gap="xs" w={280}>
      <SegmentedControl
        aria-label="Show"
        size="xs"
        fullWidth
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
        size="xs"
        data-autofocus
        maxLength={KNOWLEDGE_SEARCH_MAX_LENGTH}
        leftSection={<IconSearch size={14} stroke={1.5} />}
        value={filters.q}
        onChange={(e) => {
          // maxLength may count graphemes in the Tauri webview (WebKit), so cap in code as well.
          onFilters({ ...filters, q: clampKnowledgeSearch(e.currentTarget.value) });
        }}
      />
    </Stack>
  );
}

/** The Scope column's filter: All projects, This project or one area. */
export function ScopeFilter({ controls }: { readonly controls: ListControls }) {
  const { filters, areas, onFilters } = controls;
  return (
    <Select
      aria-label="Scope"
      size="xs"
      w={200}
      allowDeselect={false}
      checkIconPosition="right"
      // Inside the filter's popover: a dropdown in a portal would count as a click outside and close it.
      comboboxProps={{ withinPortal: false }}
      data={[
        { value: ALL, label: 'Any Scope' },
        { value: KnowledgeScope.You, label: SCOPE_ALL_PROJECTS },
        { value: KnowledgeScope.Project, label: SCOPE_THIS_PROJECT },
        ...areas.map((name) => ({ value: `${AREA_PREFIX}${name}`, label: areaScopeLabel(name) })),
      ]}
      value={scopeValue(filters)}
      onChange={(next) => {
        onFilters({ ...filters, ...scopeFrom(next) });
      }}
    />
  );
}
