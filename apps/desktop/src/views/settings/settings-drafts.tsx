import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SaveBar, SaveBarState } from '../../shell/save-bar';
import { useReportUnsaved } from '../../shell/unsaved-guard';

/**
 * One edit a page holds until Save: whether it differs from what is saved, how to save it (null once
 * saved, else the words for why not) and how to drop it.
 */
export interface Draft {
  readonly dirty: boolean;
  readonly save: () => Promise<string | null>;
  readonly discard: () => void;
}

interface DraftRegistry {
  readonly attach: (id: string, draft: { readonly current: Draft }) => void;
  readonly detach: (id: string) => void;
  readonly setDirty: (id: string, dirty: boolean) => void;
}

const DraftsContext = createContext<DraftRegistry | null>(null);

const SAVED_FOR_MS = 2500;

/** Words for a save that threw: the daemon's refusal, or what went wrong on the way. */
export function saveError(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

/**
 * A settings page's edits and its one save bar. A field on the page joins with `useDraft` (or
 * `useProjectFields`); the bar shows only while one of them differs from what is saved, and Save saves
 * them all. A page with no such field saves each change at once, and the bar says Saved for a moment
 * after one lands.
 */
export function SettingsDrafts({ children }: { readonly children: ReactNode }) {
  const drafts = useRef(new Map<string, { readonly current: Draft }>());
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = dirtyIds.size > 0;
  useReportUnsaved(dirty);
  // A new edit ends the last save's Saved, and edits undone by hand end its refusal. Only a new one:
  // the page reads as changed for a moment after its own Save, until the saved values arrive.
  const [wasDirty, setWasDirty] = useState(dirty);
  if (wasDirty !== dirty) {
    setWasDirty(dirty);
    if (dirty && saved && !saving) setSaved(false);
  }
  if (!dirty && !saving && error !== null) setError(null);

  const [registry] = useState<DraftRegistry>(() => ({
    attach: (id, draft) => {
      console.log('DBG attach', id);
      drafts.current.set(id, draft);
    },
    detach: (id) => {
      console.log('DBG detach', id);
      drafts.current.delete(id);
      setDirtyIds((ids) => {
        if (!ids.has(id)) return ids;
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    },
    setDirty: (id, isDirty) => {
      setDirtyIds((ids) => {
        if (ids.has(id) === isDirty) return ids;
        const next = new Set(ids);
        if (isDirty) next.add(id);
        else next.delete(id);
        return next;
      });
    },
  }));

  const flashSaved = useCallback(() => {
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setSaved(false);
    }, SAVED_FOR_MS);
  }, []);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  // A change that saves at once says so too, as each write lands; an action marked quiet does not.
  const queryClient = useQueryClient();
  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (
          event.type === 'updated' &&
          event.action.type === 'success' &&
          event.mutation.meta?.['quiet'] !== true
        )
          flashSaved();
      }),
    [queryClient, flashSaved],
  );

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    // The drafts are read as they are now, not as of the render this handler came from, so a Save pressed
    // as the bar appears still saves what the page holds.
    console.log(
      'DBG save',
      JSON.stringify([...drafts.current.entries()].map(([k, d]) => [k, d.current.dirty])),
      JSON.stringify([...dirtyIds]),
    );
    const pending = [...drafts.current.values()].flatMap((draft) =>
      draft.current.dirty ? [draft.current.save()] : [],
    );
    const problems = (await Promise.all(pending)).filter((p): p is string => p !== null);
    setSaving(false);
    if (problems.length > 0) setError(problems.join(' '));
    else flashSaved();
  };
  const discard = (): void => {
    for (const draft of drafts.current.values()) if (draft.current.dirty) draft.current.discard();
    setError(null);
  };

  const state: SaveBarState | null = saving
    ? SaveBarState.Saving
    : dirty
      ? SaveBarState.Unsaved
      : saved
        ? SaveBarState.Saved
        : null;
  return (
    <DraftsContext value={registry}>
      {children}
      <SaveBar
        state={state}
        error={dirty ? error : null}
        onDiscard={discard}
        onSave={() => {
          void save();
        }}
      />
    </DraftsContext>
  );
}

/** Joins a page's save bar with one draft, for as long as the caller is mounted. */
export function useJoinSaveBar(draft: Draft): void {
  const registry = useContext(DraftsContext);
  const id = useId();
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  });
  useEffect(() => {
    registry?.attach(id, latest);
    return () => {
      registry?.detach(id);
    };
  }, [registry, id]);
  useEffect(() => {
    console.log('DBG setDirty', id, draft.dirty);
    registry?.setDirty(id, draft.dirty);
  }, [registry, id, draft.dirty]);
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A value the builder edits until the page's Save: it follows the saved value until edited, and goes back
 * to following it once the two agree again. `problem` is the field's own check; Save refuses while it
 * says something.
 */
export function useDraft<T>({
  saved,
  save,
  problem,
  same = sameJson,
}: {
  /** What is saved now; undefined while it is read. */
  readonly saved: T | undefined;
  readonly save: (value: T) => Promise<unknown>;
  readonly problem?: (value: T) => string | null;
  readonly same?: (a: T, b: T) => boolean;
}) {
  const [edit, setEdit] = useState<{ readonly value: T } | null>(null);
  if (edit !== null && saved !== undefined && same(edit.value, saved)) setEdit(null);
  const value = edit === null ? saved : edit.value;
  const fieldProblem = value === undefined || problem === undefined ? null : problem(value);
  const dirty = edit !== null && saved !== undefined;
  useJoinSaveBar({
    dirty,
    save: async () => {
      if (edit === null) return null;
      if (fieldProblem !== null) return fieldProblem;
      try {
        await save(edit.value);
        return null;
      } catch (error) {
        return saveError(error);
      }
    },
    discard: () => {
      setEdit(null);
    },
  });
  return {
    value,
    problem: fieldProblem,
    set: (next: T) => {
      setEdit({ value: next });
    },
  };
}
