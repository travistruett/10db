import { TextInput } from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFrameSlots } from '../../shell/frame-slots';

/** How long the field waits after the last keystroke before the search reaches the URL. */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * The panel's search field. It holds its own text, writes `q` to the URL once typing pauses, and follows the URL
 * when something else changes `q` (Clear Filters, a link). ⌘F focuses it while the Inbox is shown.
 */
export function InboxSearchField({
  query,
  onQuery,
}: {
  /** The URL's `q`. */
  readonly query: string | undefined;
  /** Writes `q`, or removes it for undefined. */
  readonly onQuery: (query: string | undefined) => void;
}): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const { panelShown, showPanel } = useFrameSlots();
  // ⌘F while the panel is folded unfolds it first: the field takes focus once the panel is there to hold it.
  const wantsFocus = useRef(false);
  const [asked, setAsked] = useState(0);
  const [text, setText] = useState(query ?? '');
  // The last text written to the URL: a `q` that differs from it came from elsewhere.
  const [written, setWritten] = useState(query ?? '');
  const [seen, setSeen] = useState(query);
  if (seen !== query) {
    setSeen(query);
    if ((query ?? '') !== written) {
      setText(query ?? '');
      setWritten(query ?? '');
    }
  }
  const write = useDebouncedCallback((next: string) => {
    setWritten(next);
    onQuery(next === '' ? undefined : next);
  }, SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      showPanel();
      wantsFocus.current = true;
      setAsked((count) => count + 1);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [showPanel]);
  useEffect(() => {
    if (!wantsFocus.current || !panelShown) return;
    wantsFocus.current = false;
    input.current?.focus();
    input.current?.select();
  }, [asked, panelShown]);

  return (
    <TextInput
      ref={input}
      size="xs"
      aria-label="Search the Inbox"
      placeholder="Search"
      maxLength={200}
      leftSection={<IconSearch size={14} />}
      value={text}
      onChange={(event) => {
        setText(event.currentTarget.value);
        write(event.currentTarget.value);
      }}
    />
  );
}
