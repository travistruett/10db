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

/** j/k move, 1–4 choose, n focuses the note, Enter sends. Ignored while typing in a field. */
export function useInboxKeys(keys: InboxKeys): void {
  const hotkeys: HotkeyItem[] = [
    [
      'j',
      () => {
        if (keys.count > 0) keys.onMove(1);
      },
    ],
    [
      'k',
      () => {
        if (keys.count > 0) keys.onMove(-1);
      },
    ],
    ...DIGITS.map((digit, index): HotkeyItem => [
      digit,
      () => {
        if (index < keys.optionCount) keys.onChoose(index);
      },
    ]),
    [
      'n',
      () => {
        if (keys.count > 0) keys.onNote();
      },
    ],
    [
      'Enter',
      () => {
        if (keys.count > 0) keys.onSubmit();
      },
    ],
  ];
  useHotkeys(hotkeys);
}
