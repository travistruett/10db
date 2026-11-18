import {
  InboxKind,
  InboxListState,
  InboxOutcome,
  PersonId,
  ProjectId,
  InboxPageQuery,
} from '@10db/contracts';
import { z } from 'zod';
import type { InboxList } from '../../daemon/inbox-queries';

/** How far back Resolved reaches; each preset is a local midnight, so a query key holds all day. */
export const InboxSince = { Day: 'day', Week: 'week', Month: 'month' } as const;
export type InboxSince = (typeof InboxSince)[keyof typeof InboxSince];

const DAYS_BACK: Record<InboxSince, number> = { day: 0, week: 6, month: 29 };

export interface InboxSearch {
  readonly state?: InboxListState;
  readonly q?: string;
  readonly project?: ProjectId;
  readonly kind?: InboxKind;
  readonly outcome?: InboxOutcome;
  readonly person?: PersonId;
  readonly since?: InboxSince;
}

/** Each key on its own, so one that does not parse is dropped and the rest stay. */
const InboxSearchKeys = z.object({
  state: z.enum(InboxListState).optional().catch(undefined),
  // Whatever the daemon would refuse is dropped here, so the URL never makes the list fail to load.
  q: z
    .string()
    .refine((text) => InboxPageQuery.shape.q.safeParse(text).success)
    .optional()
    .catch(undefined),
  project: ProjectId.optional().catch(undefined),
  kind: z.enum(InboxKind).optional().catch(undefined),
  outcome: z.enum(InboxOutcome).optional().catch(undefined),
  person: PersonId.optional().catch(undefined),
  since: z.enum(InboxSince).optional().catch(undefined),
});

/** The URL's search, narrowed to the keys the Inbox reads; each is kept only when it parses. */
export function inboxSearch(search: Record<string, unknown>): InboxSearch {
  const parsed = InboxSearchKeys.parse(search);
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
}

/** The query a search asks, leaving out a filter its state does not use. */
export function inboxList(search: InboxSearch, now: Date): InboxList {
  const state = search.state ?? InboxListState.Open;
  const list: {
    -readonly [K in keyof InboxList]: InboxList[K];
  } = { state };
  if (search.q !== undefined) list.q = search.q;
  if (search.project !== undefined) list.project = search.project;
  if (search.kind !== undefined) list.kind = search.kind;
  if (state === InboxListState.Waiting && search.person !== undefined) list.person = search.person;
  if (state === InboxListState.Resolved) {
    if (search.outcome !== undefined) list.outcome = search.outcome;
    if (search.since !== undefined) {
      const from = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - DAYS_BACK[search.since],
      );
      list.since = from.toISOString() satisfies NonNullable<InboxPageQuery['since']>;
    }
  }
  return list;
}

/** The search with another state: Open is the default, so it leaves no key. */
export function withState(search: InboxSearch, state: InboxListState): InboxSearch {
  return inboxSearch({ ...search, state: state === InboxListState.Open ? undefined : state });
}

/** The search narrowed to a project, or to every project when `project` is null. */
export function withProject(search: InboxSearch, project: ProjectId | null): InboxSearch {
  return inboxSearch({ ...search, project: project ?? undefined });
}

/** The search with one key set, or removed when `value` is null. */
export function withFilter<K extends 'q' | 'project' | 'kind' | 'outcome' | 'person' | 'since'>(
  search: InboxSearch,
  key: K,
  value: InboxSearch[K] | null,
): InboxSearch {
  return inboxSearch({ ...search, [key]: value ?? undefined });
}

/** Whether a filter the search's state uses is set; the search text is not a filter. */
export function filtersSet(search: InboxSearch): boolean {
  return Object.keys(inboxList(search, new Date())).some((key) => key !== 'state' && key !== 'q');
}

/** Whether the list is narrowed by the search text or a filter its state uses. */
export function narrowed(search: InboxSearch): boolean {
  return Object.keys(inboxList(search, new Date())).some((key) => key !== 'state');
}

/** The search with its filters removed; the state and the search text stay. */
export function withoutFilters(search: InboxSearch): InboxSearch {
  return inboxSearch({ state: search.state, q: search.q });
}

/** The search with its text removed. */
export function withoutQuery(search: InboxSearch): InboxSearch {
  return withFilter(search, 'q', null);
}

let last: InboxSearch = {};

/** The Inbox's search as the builder left it, so the rail's Inbox opens where it was. */
export const lastInboxSearch = {
  get: (): InboxSearch => last,
  set: (search: InboxSearch): void => {
    last = search;
  },
};

interface StateMemory {
  selected: string | null;
  scrollTop: number;
}

const memory: Record<InboxListState, StateMemory> = {
  open: { selected: null, scrollTop: 0 },
  waiting: { selected: null, scrollTop: 0 },
  resolved: { selected: null, scrollTop: 0 },
};

/** A state's selected row key and list scroll, kept across switching states and leaving the page. */
export const inboxStateMemory = (state: InboxListState): StateMemory => memory[state];

/** Remembers a state's selected row key. */
export function rememberSelected(state: InboxListState, selected: string | null): void {
  memory[state].selected = selected;
}

/** Remembers a state's list scroll position. */
export function rememberScroll(state: InboxListState, scrollTop: number): void {
  memory[state].scrollTop = scrollTop;
}
