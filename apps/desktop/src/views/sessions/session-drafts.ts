import { useSyncExternalStore } from 'react';
import type { FolderWhileHeld } from '@10db/contracts';
import { z } from 'zod';
import { EMPTY_DRAFT, type Draft } from '../../conversation/drafts';

// What the builder has typed in each tab and not sent: kept for the window, so a tab switch, a closed tab
// that comes back, and a visit to another screen all find the words where they were left. A fresh tab's
// draft moves to the chat made from it, together with the request to send it. A chat's text and mentions
// are kept in `localStorage` (`tendb.sessions.drafts`) too, so a restart finds them; a picture is dropped
// on restart, as the Workbench's are.

export const DRAFTS_KEY = 'tendb.sessions.drafts';

/** A send a fresh tab asked its chat to make: how it runs when Your folder is held, when it was asked. */
export interface SendRequest {
  readonly folder?: FolderWhileHeld;
}

const Stored = z.record(z.string(), z.object({ text: z.string(), mentions: z.array(z.string()) }));

function readStored(): Map<string, Draft> {
  try {
    const parsed = Stored.safeParse(JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}'));
    if (!parsed.success) return new Map();
    return new Map(
      Object.entries(parsed.data).map(([key, d]) => [key, { ...d, pictures: [] }] as const),
    );
  } catch {
    return new Map();
  }
}

class SessionDrafts {
  private readonly drafts = readStored();
  private readonly sends = new Map<string, SendRequest>();
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
  requestSend(key: string, request: SendRequest = {}): void {
    this.sends.set(key, request);
  }

  /** The send `key` was asked to make, or null; asking answers once. */
  takeSendRequest(key: string): SendRequest | null {
    const request = this.sends.get(key) ?? null;
    this.sends.delete(key);
    return request;
  }

  private persist(): void {
    const kept: Record<string, { text: string; mentions: readonly string[] }> = {};
    for (const [key, draft] of this.drafts) {
      if (key.startsWith('chat:') && draft.text !== '')
        kept[key] = { text: draft.text, mentions: draft.mentions };
    }
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(kept));
    } catch {
      // A draft is a convenience; nothing is lost but it.
    }
  }

  private notify(): void {
    this.persist();
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
  requestSend: (key: string, request?: SendRequest): void => {
    store.requestSend(key, request);
  },
  takeSendRequest: (key: string): SendRequest | null => store.takeSendRequest(key),
};
