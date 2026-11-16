// Sessions' keys (UI spec §5.8). A pure judge: what a press means, given where the builder is.

export type SessionKey =
  | { readonly kind: 'new' }
  | { readonly kind: 'close' }
  | { readonly kind: 'reopen' }
  | { readonly kind: 'go'; readonly index: number }
  | { readonly kind: 'last' }
  | { readonly kind: 'prev' }
  | { readonly kind: 'next' }
  | { readonly kind: 'next_needing' }
  | { readonly kind: 'do_it' }
  | { readonly kind: 'stop' };

export interface Press {
  readonly key: string;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
}

export interface Place {
  readonly onSessions: boolean;
  /** Esc belongs to something open on top: a menu, a modal, a select, a waiting card. */
  readonly escapeTaken: boolean;
}

const DIGIT = /^[1-8]$/;

/** The key a press is on Sessions, or null: ⌘T is the only one that works on every view, and ⌘N is never taken. */
export function sessionKey(press: Press, place: Place): SessionKey | null {
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key;
  if (press.alt) return null;
  if (press.meta && !press.ctrl) {
    if (key === 't') return press.shift ? onSessions(place, { kind: 'reopen' }) : { kind: 'new' };
    if (press.shift) {
      if (key === '[' || key === '{') return onSessions(place, { kind: 'prev' });
      if (key === ']' || key === '}') return onSessions(place, { kind: 'next' });
      if (key === 'Enter') return onSessions(place, { kind: 'do_it' });
      return null;
    }
    if (key === 'w') return onSessions(place, { kind: 'close' });
    if (key === 'j') return onSessions(place, { kind: 'next_needing' });
    if (key === '9') return onSessions(place, { kind: 'last' });
    if (DIGIT.test(key)) return onSessions(place, { kind: 'go', index: Number(key) - 1 });
    return null;
  }
  if (press.ctrl && !press.meta && key === 'Tab') {
    return onSessions(place, { kind: press.shift ? 'prev' : 'next' });
  }
  if (key === 'Escape' && !press.meta && !press.ctrl && !press.shift && !place.escapeTaken) {
    return onSessions(place, { kind: 'stop' });
  }
  return null;
}

function onSessions(place: Place, key: SessionKey): SessionKey | null {
  return place.onSessions ? key : null;
}

/** The tab to go to for a key that moves between them, over `count` tabs with `selected` chosen. */
export function targetIndex(key: SessionKey, selected: number, count: number): number | null {
  if (count === 0) return null;
  switch (key.kind) {
    case 'go':
      return key.index < count ? key.index : null;
    case 'last':
      return count - 1;
    case 'prev':
      return (selected - 1 + count) % count;
    case 'next':
      return (selected + 1) % count;
    case 'new':
    case 'close':
    case 'reopen':
    case 'next_needing':
    case 'do_it':
    case 'stop':
      return null;
  }
}

/**
 * The next index after `selected`, in strip order and cycling, for which `needing` holds; null when
 * none does. With the selected tab the only one that needs the builder, it stays selected.
 */
export function nextNeeding(needing: readonly boolean[], selected: number): number | null {
  for (let step = 1; step <= needing.length; step += 1) {
    const index = (selected + step + needing.length) % needing.length;
    if (needing[index] === true) return index;
  }
  return null;
}
