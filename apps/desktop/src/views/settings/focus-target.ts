import { useSearch } from '@tanstack/react-router';
import { useEffect, useRef, type RefObject } from 'react';
import { z } from 'zod';

const FocusSearch = z.object({ focus: z.string().min(1) });

/** Anything the first tab stop of a card can be. */
const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), a[href], select, textarea';

/**
 * The name a link points at with `?focus=<name>`, or null for none or an unusable one. An unknown name matches
 * no card, so the section simply opens at its top.
 */
export function focusTargetOf(search: unknown): string | null {
  const parsed = FocusSearch.safeParse(search);
  return parsed.success ? parsed.data.focus : null;
}

/**
 * Makes an element the target of `?focus=<name>`: when the address names it, it is scrolled into view and its
 * first control takes keyboard focus. `focused` says the address names it.
 */
export function useFocusTarget(name: string): {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly focused: boolean;
} {
  const ref = useRef<HTMLDivElement>(null);
  const search: unknown = useSearch({ strict: false });
  const focused = focusTargetOf(search) === name;
  useEffect(() => {
    if (!focused) return;
    const element = ref.current;
    if (!element) return;
    element.scrollIntoView({ block: 'start' });
    element.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [focused]);
  return { ref, focused };
}
