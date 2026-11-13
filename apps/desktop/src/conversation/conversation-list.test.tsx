import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cssVariablesResolver, theme } from '../theme';
import { commandCall, readCall, toolEntry } from '../test/tool-call-fixtures';
import { ConversationList, type ConversationListProps } from './conversation-list';
import type { ConversationEntry } from './entry';

// Sessions UI spec §7.1 and §13.1: a long conversation mounts only the articles near the viewport,
// follows its tail unless the builder reads above it, and each message is an article with a hidden
// speaker heading. jsdom does no layout, so every article measures ROW px, the estimate, and the
// viewport is 600 px (test/setup.ts).
const ROW = 72;
const LONG = 2000;
/** The most rows a 600 px viewport can hold, with room for the overscan either side. */
const NEAR_THE_VIEWPORT = 40;

const conversation = (length: number): ConversationEntry[] =>
  Array.from({ length }, (_, i): ConversationEntry => {
    const id = `m${String(i)}`;
    const text = `Message ${String(i)}`;
    return i % 2 === 1
      ? { kind: 'reply', id, text, partial: false }
      : { kind: 'builder', id, text, extra: null };
  });

function ui(props: Partial<ConversationListProps> & Pick<ConversationListProps, 'entries'>) {
  return (
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
      <ConversationList highlight={null} agentLabel="Agent" {...props} />
    </MantineProvider>
  );
}

const viewport = (): HTMLElement => screen.getByRole('group', { name: 'Messages' });
const mounted = (): number => viewport().querySelectorAll('[data-message-id]').length;
const scrollViewportTo = (top: number): void => {
  viewport().scrollTop = top;
  fireEvent.scroll(viewport());
};

describe('ConversationList', () => {
  let count = 0;

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(ROW);
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(() => count * ROW);
    // jsdom has no Element.scrollTo, which the virtualizer writes through.
    Element.prototype.scrollTo = function scrollTo(this: Element, options?: unknown) {
      this.scrollTop = (options as ScrollToOptions).top ?? 0;
      this.dispatchEvent(new Event('scroll'));
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error jsdom has none; put that back.
    delete Element.prototype.scrollTo;
  });

  describe('windowing', () => {
    it('mounts only the rows near the viewport of a 2,000-message conversation', () => {
      count = LONG;
      render(ui({ entries: conversation(LONG) }));
      expect(screen.getByText('Message 0')).toBeTruthy();
      expect(mounted()).toBeLessThan(NEAR_THE_VIEWPORT);
      expect(screen.queryByText('Message 1999')).toBeNull();
    });

    it('mounts the rows the builder scrolls to and lets go of the ones left behind', async () => {
      count = LONG;
      render(ui({ entries: conversation(LONG) }));
      scrollViewportTo(1000 * ROW);
      expect(await screen.findByText('Message 1000')).toBeTruthy();
      expect(screen.queryByText('Message 0')).toBeNull();
      expect(mounted()).toBeLessThan(NEAR_THE_VIEWPORT);
    });

    it('mounts and scrolls to a Why? target far from the viewport', async () => {
      count = LONG;
      const entries = conversation(LONG);
      const { rerender } = render(ui({ entries }));
      const target = entries[1500];
      if (target === undefined) throw new Error('no target');
      expect(screen.queryByText('Message 1500')).toBeNull();

      rerender(ui({ entries, highlight: { ids: [target.id], nonce: 1 } }));

      const block = await screen.findByText('Message 1500');
      expect(block.closest('[data-highlighted]')).not.toBeNull();
      await waitFor(() => {
        // Centred: the article's own middle sits in the viewport's.
        expect(viewport().scrollTop).toBe(1500 * ROW + ROW / 2 - 600 / 2);
      });
      expect(mounted()).toBeLessThan(NEAR_THE_VIEWPORT);
    });

    it('follows a new message at the bottom, though the bottom row is not the last mounted', async () => {
      count = LONG;
      const entries = conversation(LONG + 1);
      const { rerender } = render(ui({ entries: entries.slice(0, LONG) }));
      scrollViewportTo(LONG * ROW - 600);
      await screen.findByText('Message 1999');

      count = LONG + 1;
      rerender(ui({ entries }));

      expect(await screen.findByText('Message 2000')).toBeTruthy();
      await waitFor(() => {
        expect(viewport().scrollTop).toBe((LONG + 1) * ROW - 600);
      });
    });

    it('stays where the builder is reading when a message arrives', async () => {
      count = LONG;
      const entries = conversation(LONG + 1);
      const { rerender } = render(ui({ entries: entries.slice(0, LONG) }));
      scrollViewportTo(500 * ROW);
      await screen.findByText('Message 500');

      count = LONG + 1;
      rerender(ui({ entries }));

      expect(await screen.findByText('Message 500')).toBeTruthy();
      expect(viewport().scrollTop).toBe(500 * ROW);
      expect(screen.queryByText('Message 2000')).toBeNull();
    });
  });

  describe('row state', () => {
    it('keeps a pressed Allow This pressed after the row scrolls away and back', async () => {
      count = LONG + 1;
      const held = toolEntry(
        commandCall({
          id: 'held',
          status: 'denied',
          deniedBy: 'judge',
          limit: 'sends_data_out',
          soft: true,
        }),
      );
      const onAllow = vi.fn();
      render(ui({ entries: [held, ...conversation(LONG)], onAllow }));
      fireEvent.click(screen.getByRole('button', { name: 'Allow This' }));
      scrollViewportTo(1000 * ROW);
      await screen.findByText('Message 1000');
      expect(screen.queryByText('You allowed this')).toBeNull();
      scrollViewportTo(0);
      expect(await screen.findByText('You allowed this')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Allow This' })).toBeNull();
      expect(onAllow).toHaveBeenCalledTimes(1);
    });

    it('keeps an opened row open after it scrolls away and back', async () => {
      count = LONG + 1;
      const row = toolEntry(commandCall({ id: 'cmd', outputTail: 'PASS all' }));
      render(ui({ entries: [row, ...conversation(LONG)] }));
      fireEvent.click(screen.getByRole('button', { name: /^Ran pnpm/ }));
      scrollViewportTo(1000 * ROW);
      await screen.findByText('Message 1000');
      scrollViewportTo(0);
      expect(await screen.findByText('PASS all')).toBeTruthy();
    });
  });

  describe('Jump to Latest', () => {
    it('shows while the builder reads above the tail, and takes them to the end', async () => {
      count = LONG;
      render(ui({ entries: conversation(LONG) }));
      scrollViewportTo(LONG * ROW - 600);
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Jump to Latest' })).toBeNull();
      });
      scrollViewportTo((LONG - 500) * ROW - 600);
      fireEvent.click(await screen.findByRole('button', { name: 'Jump to Latest' }));
      await waitFor(() => {
        expect(viewport().scrollTop).toBe(LONG * ROW - 600);
      });
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Jump to Latest' })).toBeNull();
      });
    });
  });

  describe('articles and rows', () => {
    beforeEach(() => {
      count = 4;
    });

    it("puts the builder's message on a panel in an article headed by a hidden You", () => {
      render(ui({ entries: [{ kind: 'builder', id: 'b', text: 'Make it so', extra: null }] }));
      const article = screen.getByRole('article', { name: 'You' });
      expect(within(article).getByText('Make it so').closest('[data-panel]')).not.toBeNull();
      expect(
        within(article)
          .getByRole('heading', { name: 'You' })
          .closest('.mantine-VisuallyHidden-root'),
      ).not.toBeNull();
    });

    it("draws a reply's markdown in an article headed by the agent's label", () => {
      render(
        ui({
          entries: [{ kind: 'reply', id: 'r', text: '# Done', partial: false }],
          agentLabel: 'Codex',
        }),
      );
      const article = screen.getByRole('article', { name: 'Codex' });
      expect(within(article).getByRole('heading', { level: 1, name: 'Done' })).toBeTruthy();
    });

    it('ends a partial reply with Stopped here.', () => {
      render(ui({ entries: [{ kind: 'reply', id: 'r', text: 'Half', partial: true }] }));
      expect(screen.getByText('Stopped here.')).toBeTruthy();
    });

    it('folds three reads into one row', () => {
      const entries = ['a', 'b', 'c'].map((p) =>
        toolEntry(readCall({ id: p, path: `src/${p}.ts` })),
      );
      render(ui({ entries }));
      expect(screen.getByRole('button', { name: 'Read 3 files' })).toBeTruthy();
    });

    it('draws what a custom entry returns', () => {
      render(ui({ entries: [{ kind: 'custom', id: 'x', render: () => <p>A screenshot</p> }] }));
      expect(screen.getByText('A screenshot')).toBeTruthy();
    });

    it("copies a reply's markdown source", () => {
      const writeText = vi.fn(() => Promise.resolve());
      const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      render(ui({ entries: [{ kind: 'reply', id: 'r', text: '**bold** `x`', partial: false }] }));
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      expect(writeText).toHaveBeenCalledWith('**bold** `x`');
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    });

    it('draws reasoning closed, opening to its text', () => {
      render(
        ui({ entries: [{ kind: 'reasoning', id: 'th', text: 'Weighing it', durationMs: 12_000 }] }),
      );
      expect(screen.queryByText('Weighing it')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Thought for 12 s' }));
      expect(screen.getByText('Weighing it')).toBeTruthy();
    });
  });
});
