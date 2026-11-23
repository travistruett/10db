import { useSearch } from '@tanstack/react-router';
import { useEffect, useRef, type RefObject } from 'react';
import { z } from 'zod';

const FocusParam = z.string().min(1);

/** The kinds of model a Models page can list; the address says which, and Agent is the default. */
export const ModelClass = { Agent: 'agent', Decision: 'decision' } as const;
export type ModelClass = (typeof ModelClass)[keyof typeof ModelClass];

const ClassParam = z.enum([ModelClass.Agent, ModelClass.Decision]);

/** The `focus` and `class` parts of a Settings address, each kept only when it is valid. */
export function settingsSearch(search: Record<string, unknown>): {
  focus?: string;
  class?: ModelClass;
} {
  const focus = FocusParam.safeParse(search['focus']);
  const modelClass = ClassParam.safeParse(search['class']);
  return {
    ...(focus.success ? { focus: focus.data } : {}),
    ...(modelClass.success ? { class: modelClass.data } : {}),
  };
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
