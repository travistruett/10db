import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_CAPABILITIES } from '../test/conversation-fixtures';
import { renderWithTheme } from '../test/theme';
import { Composer, type ComposerProps } from './composer';
import { composerPhase, type ComposerPhase } from './composer-phase';
import { EMPTY_DRAFT, type Draft } from './drafts';

// Sessions UI spec §7.9, §7.11.

const IDLE: ComposerPhase = composerPhase({
  state: 'idle_warm',
  hasText: true,
  steer: 'inject',
  project: 'ampsio',
  fresh: false,
  narrow: false,
});

/** Holds the draft as a screen does. */
function Held(props: Partial<ComposerProps> & { readonly start?: Draft }) {
  const [draft, setDraft] = useState(props.start ?? EMPTY_DRAFT);
  return (
    <Composer
      draft={draft}
      onDraft={setDraft}
      capabilities={CLAUDE_CAPABILITIES}
      phase={IDLE}
      disabledReason={null}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onRedo={vi.fn()}
      {...props}
    />
  );
}

const input = (): HTMLElement => screen.getByRole('textbox', { name: 'Message' });

describe('Composer', () => {
  it('⌘↩ sends the draft and clears it; Enter is a new line', async () => {
    const onSend = vi.fn();
    renderWithTheme(<Held onSend={onSend} />);
    fireEvent.change(input(), { target: { value: 'hello\nthere' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith({ text: 'hello\nthere', mentions: [], pictures: [] });
    });
    await waitFor(() => {
      expect((input() as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('never sends while an IME composes', () => {
    const onSend = vi.fn();
    renderWithTheme(<Held onSend={onSend} start={{ ...EMPTY_DRAFT, text: 'こんにちは' }} />);
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true, keyCode: 229 });
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true, isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps the draft and says why when a send is refused', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('Not available on this account'));
    renderWithTheme(<Held onSend={onSend} start={{ ...EMPTY_DRAFT, text: 'hi' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Not available on this account')).toBeTruthy();
    expect((input() as HTMLTextAreaElement).value).toBe('hi');
  });

  it('refuses a picture type outside the capabilities, in words, and holds a png', () => {
    renderWithTheme(<Held />);
    const gif = new File(['x'], 'pasted.gif', { type: 'image/gif' });
    fireEvent.paste(input(), { clipboardData: { files: [gif], getData: () => '' } });
    expect(
      screen.getByText(/pasted\.gif can’t be added: paste a PNG or JPEG picture/),
    ).toBeTruthy();
    const png = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(input(), { clipboardData: { files: [png], getData: () => '' } });
    expect(screen.getByRole('button', { name: 'Remove shot.png' })).toBeTruthy();
  });

  it('hides Attach when the agent takes no images', () => {
    renderWithTheme(<Held capabilities={{ ...CLAUDE_CAPABILITIES, images: [] }} />);
    expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('Stop posts nothing but onStop; Stop and Redo hands over the draft', async () => {
    const onStop = vi.fn();
    const onRedo = vi.fn();
    const working = (hasText: boolean): ComposerPhase =>
      composerPhase({
        state: 'running',
        hasText,
        steer: 'inject',
        project: 'ampsio',
        fresh: false,
        narrow: false,
      });
    const first = renderWithTheme(<Held phase={working(false)} onStop={onStop} onRedo={onRedo} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onRedo).not.toHaveBeenCalled();
    first.unmount();
    renderWithTheme(
      <Held
        phase={working(true)}
        onStop={onStop}
        onRedo={onRedo}
        start={{ ...EMPTY_DRAFT, text: 'no, this' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop and Redo' }));
    await waitFor(() => {
      expect(onRedo).toHaveBeenCalledWith({ text: 'no, this', mentions: [], pictures: [] });
    });
  });

  it('disables Send with the reason it is given', () => {
    renderWithTheme(
      <Held
        disabledReason="Reconnecting… your message stays here."
        start={{ ...EMPTY_DRAFT, text: 'hi' }}
      />,
    );
    expect(screen.getByText('Reconnecting… your message stays here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('Composer: @ files and / commands', () => {
  const files = [
    { path: 'src/login.ts', matches: [[4, 9]] as [number, number][] },
    { path: 'src/auth/login-form.tsx', matches: [[9, 14]] as [number, number][] },
  ];
  const commands = [
    { name: 'compact', description: 'Summarize the conversation', argumentHint: null },
    { name: 'review', description: 'Review a pull request', argumentHint: '[pr]' },
  ];
  const type = (text: string): void => {
    fireEvent.change(input(), { target: { value: text } });
  };
  const nine = Array.from({ length: 9 }, (_, i) => ({
    path: `src/log${String(i)}.ts`,
    matches: [],
  }));

  it('lists at most 8 files for @log, each as its name with the folder dimmed', async () => {
    const lookup = vi.fn().mockResolvedValue(nine);
    renderWithTheme(<Held mentions={{ files: lookup, commands: null }} />);
    type('@log');
    const options = await screen.findAllByRole('option', { hidden: true });
    expect(options).toHaveLength(8);
    expect(lookup).toHaveBeenCalledWith('log', expect.any(AbortSignal));
  });

  it('Enter picks a file as a chip without sending; ⌘↩ sends its path in the text and the list of mentions', async () => {
    const onSend = vi.fn();
    const lookup = vi.fn().mockResolvedValue(files);
    renderWithTheme(<Held onSend={onSend} mentions={{ files: lookup, commands: null }} />);
    type('@log');
    await screen.findAllByRole('option', { hidden: true });
    // ⌘↩ with the list open belongs to the list.
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => {
      expect((input() as HTMLTextAreaElement).value).toBe('@src/login.ts ');
    });
    type('@src/login.ts why');
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith({
        text: '@src/login.ts why',
        mentions: ['src/login.ts'],
        pictures: [],
      });
    });
  });

  it('a plain Enter with the list open picks; with it closed it is a new line', async () => {
    const onSend = vi.fn();
    renderWithTheme(
      <Held
        onSend={onSend}
        mentions={{ files: vi.fn().mockResolvedValue(files), commands: null }}
      />,
    );
    type('@log');
    await screen.findAllByRole('option', { hidden: true });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => {
      expect((input() as HTMLTextAreaElement).value).toBe('@src/login.ts ');
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('lists the agent’s commands for / at the start, and not mid-sentence', async () => {
    renderWithTheme(<Held mentions={{ commands }} capabilities={CLAUDE_CAPABILITIES} />);
    type('/co');
    expect(await screen.findByRole('option', { name: /compact/, hidden: true })).toBeTruthy();
    expect(screen.getByText('Summarize the conversation')).toBeTruthy();
    expect(screen.queryByRole('option', { name: /review/, hidden: true })).toBeNull();
    type('see /co');
    await waitFor(() => {
      expect(screen.queryAllByRole('option', { hidden: true })).toHaveLength(0);
    });
  });

  it('with slash commands off, / types a slash and lists nothing', () => {
    renderWithTheme(
      <Held
        mentions={{ commands }}
        capabilities={{ ...CLAUDE_CAPABILITIES, slashCommands: false }}
      />,
    );
    type('/co');
    expect(screen.queryAllByRole('option', { hidden: true })).toHaveLength(0);
    expect((input() as HTMLTextAreaElement).value).toBe('/co');
  });

  it('picking a command inserts it, and ⌘↩ sends it as /name', async () => {
    const onSend = vi.fn();
    renderWithTheme(<Held onSend={onSend} mentions={{ commands }} />);
    type('/co');
    await screen.findByRole('option', { name: /compact/, hidden: true });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => {
      expect((input() as HTMLTextAreaElement).value).toBe('/compact ');
    });
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith({ text: '/compact ', mentions: [], pictures: [] });
    });
  });
});
