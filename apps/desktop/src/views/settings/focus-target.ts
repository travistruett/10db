import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, type RefObject } from 'react';
import { z } from 'zod';

const FocusParam = z.string().min(1);

/** The kinds of model a Models page can list; the address says which, and Agent is the default. */
export const ModelClass = { Agent: 'agent', Decision: 'decision' } as const;
export type ModelClass = (typeof ModelClass)[keyof typeof ModelClass];

const ClassParam = z.enum([ModelClass.Agent, ModelClass.Decision]);
const TabParam = z.string().min(1);

/**
 * The `focus`, `class` and `tab` parts of a Settings address, each kept only when it is valid. `tab` is any word:
 * the page that has tabs reads it with `useSettingsTab`, so a link can land on one.
 */
export function settingsSearch(search: Record<string, unknown>): {
  focus?: string;
  class?: ModelClass;
  tab?: string;
} {
  const focus = FocusParam.safeParse(search['focus']);
  const modelClass = ClassParam.safeParse(search['class']);
  const tab = TabParam.safeParse(search['tab']);
  return {
    ...(focus.success ? { focus: focus.data } : {}),
    ...(modelClass.success ? { class: modelClass.data } : {}),
    ...(tab.success ? { tab: tab.data } : {}),
  };
}

/**
 * A Settings page's open tab, kept in the address as `?tab=` so a link lands on it: the tab the address names, or
 * the first when it names none of the page's. Choosing one replaces the address rather than adding to history.
 */
export function useSettingsTab<T extends string>(
  section: string,
  tabs: readonly { readonly value: T }[],
  first: T,
): readonly [T, (next: T) => void] {
  const navigate = useNavigate();
  const named = settingsSearch(useSearch({ strict: false })).tab;
  const open = tabs.find((t) => t.value === named)?.value ?? first;
  return [
    open,
    (next) => {
      void navigate({
        to: '/settings/$section',
        params: { section },
        search: (previous) => ({ ...previous, tab: next }),
        replace: true,
      });
    },
  ];
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]';

/**
 * Marks an element as what `?focus=<name>` points at. When the address names it, the element scrolls
 * into view and its first focusable control takes focus; any other name does nothing.
 */
export function useFocusTarget<T extends HTMLElement>(
  name: string,
): { readonly ref: RefObject<T | null>; readonly focused: boolean } {
  const ref = useRef<T>(null);
  const search = useSearch({ strict: false });
  const focused = settingsSearch(search).focus === name;
  useEffect(() => {
    if (!focused) return;
    const element = ref.current;
    if (!element) return;
    element.scrollIntoView({ block: 'center' });
    element.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [focused]);
  return { ref, focused };
}
