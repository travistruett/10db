import { useSyncExternalStore } from 'react';
import { EMPTY_DRAFT, type Draft } from '../../conversation/drafts';

// What the builder has typed in each tab and not sent: kept for the window, so a tab switch, a closed tab
// that comes back, and a visit to another screen all find the words where they were left. A fresh tab's
// draft moves to the chat made from it, together with the request to send it.

class SessionDrafts {
  private readonly drafts = new Map<string, Draft>();
  private readonly sends = new Set<string>();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(key: string): Draft {
    return this.drafts.get(key) ?? EMPTY_DRAFT;
  }

  set(key: string, draft: Draft): void {
    if (draft === EMPTY_DRAFT || (draft.text === '' && draft.pictures.length === 0))
      this.drafts.delete(key);
    else this.drafts.set(key, draft);
    this.notify();
  }

  /** The draft of `from` becomes the draft of `to`; `from` is left empty. */
  move(from: string, to: string): void {
    const draft = this.get(from);
    this.drafts.delete(from);
    if (draft !== EMPTY_DRAFT) this.drafts.set(to, draft);
    this.notify();
  }

  /** The tab `key` should send its draft as soon as it is drawn. */
  requestSend(key: string): void {
    this.sends.add(key);
  }

  /** Whether `key` was asked to send; asking answers once. */
  takeSendRequest(key: string): boolean {
    return this.sends.delete(key);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

const store = new SessionDrafts();

/** A tab's key for its draft. */
export const draftKey = {
  chat: (id: string): string => `chat:${id}`,
  fresh: (id: string): string => `fresh:${id}`,
} as const;

/** The draft of the tab `key`, and a way to change it. */
export function useSessionDraft(key: string): [Draft, (draft: Draft) => void] {
  const draft = useSyncExternalStore(store.subscribe, () => store.get(key));
  return [
    draft,
    (next) => {
      store.set(key, next);
    },
  ];
}

export const sessionDrafts = {
  get: (key: string): Draft => store.get(key),
  set: (key: string, draft: Draft): void => {
    store.set(key, draft);
  },
  move: (from: string, to: string): void => {
    store.move(from, to);
  },
  requestSend: (key: string): void => {
    store.requestSend(key);
  },
  takeSendRequest: (key: string): boolean => store.takeSendRequest(key),
};
