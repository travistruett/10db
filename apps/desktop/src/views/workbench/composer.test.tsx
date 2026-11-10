import { act, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { baseHandlers, renderWithDaemon, server } from '../../test/daemon';
import { Composer, type PageActions } from './composer';
import { EMPTY_DRAFT, type Draft } from './drafts';
import { PageStatus } from './page-status';

beforeEach(() => {
  server.use(...baseHandlers());
});

function actions(): PageActions & { [K in keyof PageActions]: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    redo: vi.fn(() => Promise.resolve()),
    signOff: vi.fn(() => Promise.resolve()),
  };
}

function Harness(props: { status: PageStatus; actions: PageActions; firstMessage?: boolean }) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  return (
    <Composer
      area="Settings"
      status={props.status}
      firstMessage={props.firstMessage ?? false}
      draft={draft}
      onDraft={setDraft}
      actions={props.actions}
      openPage={null}
    />
  );
}

async function renderComposer(status: PageStatus, firstMessage = false) {
  const acts = actions();
  renderWithDaemon(<Harness status={status} actions={acts} firstMessage={firstMessage} />);
  const input = await screen.findByRole('textbox', { name: 'Message to Settings' });
  return { acts, input };
}

function variant(name: string): string | null {
  return screen.getByRole('button', { name }).getAttribute('data-variant');
}

describe('Composer buttons', () => {
  it('on a Ready page: Sign Off is the primary until the builder types, then Send is', async () => {
    const { acts, input } = await renderComposer(PageStatus.Ready);
    expect(variant('Sign Off')).toBe('filled');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.change(input, { target: { value: 'padding too tight' } });
    expect(variant('Send')).toBe('filled');
    expect(variant('Sign Off')).toBe('default');
    fireEvent.click(screen.getByRole('button', { name: 'Sign Off' }));
    expect(acts.signOff).toHaveBeenCalledOnce();
  });

  it('⌘↩ sends the draft and empties the input', async () => {
    const { acts, input } = await renderComposer(PageStatus.Ready);
    fireEvent.change(input, { target: { value: 'padding too tight' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
      await Promise.resolve();
    });
    expect(acts.send).toHaveBeenCalledWith({ text: 'padding too tight', pictures: [] });
    expect((input as HTMLTextAreaElement).value).toBe('');
  });

  it('while a turn works: an empty composer stops plainly, a typed one redoes with the text', async () => {
    const { acts, input } = await renderComposer(PageStatus.Working);
    expect(input.getAttribute('placeholder')).toBe('Add to this turn…');
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    await act(async () => {
      fireEvent.click(stop);
      await Promise.resolve();
    });
    expect(acts.stop).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { value: 'use the old header' } });
    expect(variant('Send')).toBe('filled');
    expect(variant('Stop and Redo')).toBe('default');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop and Redo' }));
      await Promise.resolve();
    });
    expect(acts.redo).toHaveBeenCalledWith({ text: 'use the old header', pictures: [] });
    expect(acts.send).not.toHaveBeenCalled();
  });

  it('asks what should change before the first message', async () => {
    const { input } = await renderComposer(PageStatus.NotStarted, true);
    expect(input.getAttribute('placeholder')).toBe(
      'What should change on Settings? Paste a screenshot…',
    );
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows the daemon’s refusal beside the buttons and keeps the draft', async () => {
    const { acts, input } = await renderComposer(PageStatus.NotStarted);
    acts.send.mockRejectedValueOnce(new Error('A message needs words or a picture'));
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('A message needs words or a picture')).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe('hello');
  });
});

describe('Composer pictures', () => {
  it('takes a pasted screenshot, which alone can be sent', async () => {
    const { acts, input } = await renderComposer(PageStatus.NotStarted);
    const shot = new File([new Uint8Array([1])], 'image', { type: 'image/png' });
    fireEvent.paste(input, { clipboardData: { files: [shot], getData: () => '' } });
    expect(screen.getByRole('list', { name: 'Pictures to send' }).textContent).toBe(
      'pasted-image.png',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await Promise.resolve();
    });
    expect(acts.send).toHaveBeenCalledWith({
      text: '',
      pictures: [expect.objectContaining({ name: 'pasted-image.png' })],
    });
  });

  it('takes a dropped JPEG and refuses a GIF with its reason', async () => {
    const { input } = await renderComposer(PageStatus.Ready);
    const jpeg = new File([new Uint8Array([1])], 'after.jpg', { type: 'image/jpeg' });
    const gif = new File([new Uint8Array([1])], 'spinner.gif', { type: 'image/gif' });
    fireEvent.drop(input, { dataTransfer: { types: ['Files'], files: [jpeg, gif] } });
    expect(screen.getByRole('list', { name: 'Pictures to send' }).textContent).toBe('after.jpg');
    expect(
      screen.getByText('spinner.gif can’t be added: paste a PNG, JPEG or WebP picture'),
    ).toBeTruthy();
    // A picture is something to send: Send becomes the primary.
    expect(variant('Send')).toBe('filled');
  });

  it('takes a picked WebP from Add Picture, and a picture can be removed', async () => {
    await renderComposer(PageStatus.Ready);
    const webp = new File([new Uint8Array([1])], 'menu.webp', { type: 'image/webp' });
    fireEvent.change(screen.getByLabelText('Choose pictures'), { target: { files: [webp] } });
    expect(screen.getByRole('list', { name: 'Pictures to send' }).textContent).toBe('menu.webp');
    fireEvent.click(screen.getByRole('button', { name: 'Remove menu.webp' }));
    expect(screen.queryByRole('list', { name: 'Pictures to send' })).toBeNull();
  });
});
