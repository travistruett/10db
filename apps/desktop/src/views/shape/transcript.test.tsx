import { mintId, type ShapeMessageDto } from '@10db/contracts';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shapeMessageDto } from '../../test/shape-fixtures';
import { cssVariablesResolver, theme } from '../../theme';
import { Transcript, type TranscriptProps } from './transcript';

// Shape spec §4: a long conversation mounts only the blocks near the viewport. jsdom does no layout,
// so every block measures ROW px, the estimate, and the viewport is 600 px (test/setup.ts).
const ROW = 72;
const LONG = 2000;
/** The most blocks a 600 px viewport can hold, with room for the overscan either side. */
const NEAR_THE_VIEWPORT = 40;

const shapeId = mintId('Shape');
const conversation = (length: number): ShapeMessageDto[] =>
  Array.from({ length }, (_, i) =>
    shapeMessageDto(shapeId, {
      author: i % 2 === 0 ? 'builder' : 'claude',
      body: `Message ${String(i)}`,
    }),
  );

function ui(props: TranscriptProps) {
  return (
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
      <Transcript {...props} />
    </MantineProvider>
  );
}

const viewport = (): HTMLElement => screen.getByRole('group', { name: 'Messages' });
const mounted = (): number => viewport().querySelectorAll('[data-message-id]').length;
const scrollViewportTo = (top: number): void => {
  viewport().scrollTop = top;
  fireEvent.scroll(viewport());
};

describe('Transcript', () => {
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

  it('mounts only the blocks near the viewport of a 2,000-message conversation', () => {
    count = LONG;
    render(ui({ messages: conversation(LONG), why: null }));
    expect(screen.getByText('Message 0')).toBeTruthy();
    expect(mounted()).toBeLessThan(NEAR_THE_VIEWPORT);
    expect(screen.queryByText('Message 1999')).toBeNull();
  });

  it('mounts the blocks the builder scrolls to and lets go of the ones left behind', async () => {
    count = LONG;
    render(ui({ messages: conversation(LONG), why: null }));
    scrollViewportTo(1000 * ROW);
    expect(await screen.findByText('Message 1000')).toBeTruthy();
    expect(screen.queryByText('Message 0')).toBeNull();
    expect(mounted()).toBeLessThan(NEAR_THE_VIEWPORT);
  });

  it('mounts and scrolls to a Why? target far from the viewport', async () => {
    count = LONG;
    const messages = conversation(LONG);
    const { rerender } = render(ui({ messages, why: null }));
    const target = messages[1500];
    if (target === undefined) throw new Error('no target');
    expect(screen.queryByText('Message 1500')).toBeNull();

    rerender(ui({ messages, why: { ids: [target.id], nonce: 1 } }));

    const block = await screen.findByText('Message 1500');
    expect(block.closest('[data-highlighted]')).not.toBeNull();
    await waitFor(() => {
      // Centred: the block's own middle sits in the viewport's.
      expect(viewport().scrollTop).toBe(1500 * ROW + ROW / 2 - 600 / 2);
    });
    expect(mounted()).toBeLessThan(NEAR_THE_VIEWPORT);
  });

  it('follows a new message at the bottom, though the bottom block is not the last mounted', async () => {
    count = LONG;
    const messages = conversation(LONG + 1);
    const { rerender } = render(ui({ messages: messages.slice(0, LONG), why: null }));
    scrollViewportTo(LONG * ROW - 600);
    await screen.findByText('Message 1999');

    count = LONG + 1;
    rerender(ui({ messages, why: null }));

    expect(await screen.findByText('Message 2000')).toBeTruthy();
    await waitFor(() => {
      expect(viewport().scrollTop).toBe((LONG + 1) * ROW - 600);
    });
  });

  it('stays where the builder is reading when a message arrives', async () => {
    count = LONG;
    const messages = conversation(LONG + 1);
    const { rerender } = render(ui({ messages: messages.slice(0, LONG), why: null }));
    scrollViewportTo(500 * ROW);
    await screen.findByText('Message 500');

    count = LONG + 1;
    rerender(ui({ messages, why: null }));

    expect(await screen.findByText('Message 500')).toBeTruthy();
    expect(viewport().scrollTop).toBe(500 * ROW);
    expect(screen.queryByText('Message 2000')).toBeNull();
  });
});
