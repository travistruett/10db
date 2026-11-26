// Pick on Page spec §5: the picker's calls into the shell. The page shares this world, so nothing here
// is trusted by the shell; each call is checked again there and can only touch one page's draft.

import type { PagePickInput } from './pick';

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

function internals(): TauriInternals | null {
  const candidate: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
  if (typeof candidate !== 'object' || candidate === null) return null;
  const invoke: unknown = Reflect.get(candidate, 'invoke');
  if (typeof invoke !== 'function') return null;
  return {
    invoke: (cmd, args) => Promise.resolve(Reflect.apply(invoke, candidate, [cmd, args])),
  };
}

/** The page the window's picks go to, as the shell names it; null when the shell gives none. */
function pageOf(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const page: unknown = Reflect.get(answer, 'page');
  return typeof page === 'string' ? page : null;
}

/** Why a call was refused, in the shell's words. */
export function refusalOf(error: unknown): string {
  return typeof error === 'string' ? error : 'the pick could not reach 10db';
}

export const channel = {
  available: (): boolean => internals() !== null,
  target: async (): Promise<string | null> => pageOf(await internals()?.invoke('preview_target')),
  add: async (pick: PagePickInput): Promise<string | null> =>
    pageOf(await internals()?.invoke('add_pick', { pick: JSON.stringify(pick) })),
  remove: async (pickId: string): Promise<void> => {
    await internals()?.invoke('remove_pick', { pickId });
  },
  showComposer: async (): Promise<void> => {
    await internals()?.invoke('show_composer');
  },
  dictate: async (): Promise<void> => {
    await internals()?.invoke('preview_dictation');
  },
};
