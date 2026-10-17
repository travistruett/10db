import { useHotkeys, type HotkeyItem } from '@mantine/hooks';

export interface InboxKeys {
  readonly count: number;
  readonly optionCount: number;
  readonly onMove: (delta: 1 | -1) => void;
  readonly onChoose: (index: number) => void;
  readonly onNote: () => void;
  readonly onSubmit: () => void;
}

const DIGITS = ['1', '2', '3', '4'] as const;

/** Marks the selected card, so keys pressed inside it still count. */
export const SELECTED_CARD_ATTRIBUTE = 'data-inbox-selected';

/** Keys count on the page itself or inside the selected card; a focused link or button elsewhere keeps its own key. */
function inScope(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return (
    target === document.body ||
    target === document.documentElement ||
    target.closest(`[${SELECTED_CARD_ATTRIBUTE}]`) !== null
  );
}

/** j/k move, 1–4 choose, n focuses the note, Enter sends. Ignored while typing in a field. */
export function useInboxKeys(keys: InboxKeys): void {
  // The default action is cancelled only for a key the inbox handles, never for one left to its target.
  const scoped =
    (act: () => void) =>
    (event: KeyboardEvent): void => {
      if (!inScope(event.target)) return;
      event.preventDefault();
      act();
    };
  const hotkeys: HotkeyItem[] = [
    [
      'j',
      scoped(() => {
        if (keys.count > 0) keys.onMove(1);
      }),
      { preventDefault: false },
    ],
    [
      'k',
      scoped(() => {
        if (keys.count > 0) keys.onMove(-1);
      }),
      { preventDefault: false },
    ],
    ...DIGITS.map((digit, index): HotkeyItem => [
      digit,
      scoped(() => {
        if (index < keys.optionCount) keys.onChoose(index);
      }),
      { preventDefault: false },
    ]),
    [
      'n',
      scoped(() => {
        if (keys.count > 0) keys.onNote();
      }),
      { preventDefault: false },
    ],
    [
      'Enter',
      scoped(() => {
        if (keys.count > 0) keys.onSubmit();
      }),
      { preventDefault: false },
    ],
  ];
  useHotkeys(hotkeys);
}
