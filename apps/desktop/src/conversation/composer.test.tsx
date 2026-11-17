import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
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
  it.each([
    { name: 'Enter', key: { key: 'Enter' }, sends: true },
    { name: '⌘↩', key: { key: 'Enter', metaKey: true }, sends: true },
    { name: 'Shift+Enter', key: { key: 'Enter', shiftKey: true }, sends: false },
  ])('$name: sends is $sends; the draft clears only when it sends', async ({ key, sends }) => {
    const onSend = vi.fn();
    renderWithTheme(<Held onSend={onSend} />);
    fireEvent.change(input(), { target: { value: 'hello\nthere' } });
    // A key that is not sent is not cancelled either: the browser makes its new line.
    const notCancelled = fireEvent.keyDown(input(), key);
    expect(notCancelled).toBe(!sends);
    if (!sends) {
      expect(onSend).not.toHaveBeenCalled();
      return;
    }
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
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps the draft and says why when a send is refused', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('Not available on this account'));
    renderWithTheme(<Held onSend={onSend} start={{ ...EMPTY_DRAFT, text: 'hi' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Not available on this account')).toBeTruthy();
    expect((input() as HTMLTextAreaElement).value).toBe('hi');
  });

  it('puts a failed send back ahead of what was typed while it was on its way', async () => {
    let refuse = (): void => undefined;
    const onSend = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = () => {
            reject(new Error('The database is locked'));
          };
        }),
    );
    renderWithTheme(<Held onSend={onSend} start={{ ...EMPTY_DRAFT, text: 'first' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.change(input(), { target: { value: 'second thought' } });
    refuse();
    expect(await screen.findByText('The database is locked')).toBeTruthy();
    expect((input() as HTMLTextAreaElement).value).toBe('first\n\nsecond thought');
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

  it('draws a waiting picture from a data address, the only kind the window’s policy lets an image load from', async () => {
    renderWithTheme(<Held />);
    const png = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    fireEvent.paste(input(), { clipboardData: { files: [png], getData: () => '' } });
    const list = screen.getByRole('list', { name: 'Pictures to send' });
    await waitFor(() => {
      expect(list.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    });
  });

  it('shows where to drop while files are dragged over the input, and takes them on drop', () => {
    renderWithTheme(<Held />);
    const frame = input().closest('[data-composer-frame]');
    if (frame === null) throw new Error('the composer has no frame');
    const png = new File(['x'], 'dropped.png', { type: 'image/png' });
    expect(screen.queryByText('Drop Pictures to Attach')).toBeNull();
    // A drag that carries no file (selected text) shows nothing.
    fireEvent.dragEnter(frame, { dataTransfer: { types: ['text/plain'] } });
    expect(screen.queryByText('Drop Pictures to Attach')).toBeNull();
    fireEvent.dragEnter(frame, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByText('Drop Pictures to Attach')).toBeTruthy();
    fireEvent.drop(frame, { dataTransfer: { types: ['Files'], files: [png] } });
    expect(screen.queryByText('Drop Pictures to Attach')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove dropped.png' })).toBeTruthy();
  });

  it('hides the drop target when the drag leaves the input', () => {
    renderWithTheme(<Held />);
    const frame = input().closest('[data-composer-frame]');
    if (frame === null) throw new Error('the composer has no frame');
    const files = { dataTransfer: { types: ['Files'] } };
    fireEvent.dragEnter(frame, files);
    // Moving onto a child of the frame enters the child and leaves the frame: still over the input.
    fireEvent.dragEnter(input(), files);
    fireEvent.dragLeave(frame, files);
    expect(screen.getByText('Drop Pictures to Attach')).toBeTruthy();
    fireEvent.dragLeave(input(), files);
    expect(screen.queryByText('Drop Pictures to Attach')).toBeNull();
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

  it('keeps what was typed while a send was on its way once that send succeeds', async () => {
    let settle = (): void => undefined;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    renderWithTheme(<Held onSend={onSend} start={{ ...EMPTY_DRAFT, text: 'first' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // The input empties as Send is pressed, not once the daemon answers.
    expect((input() as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(input(), { target: { value: 'second thought' } });
    settle();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('data-loading')).toBe(false);
    });
    expect((input() as HTMLTextAreaElement).value).toBe('second thought');
  });

  describe('a send and a Stop on their way together', () => {
    const held = (): { promise: Promise<void>; settle: () => void } => {
      let settle = (): void => undefined;
      const promise = new Promise<void>((resolve) => {
        settle = resolve;
      });
      return { promise, settle };
    };
    // Plan's phase: a plain Stop while a turn runs, and Send beside it.
    const PLAIN_STOP: ComposerPhase = {
      stop: 'stop',
      send: 'default',
      placeholder: 'Talk it through…',
      hint: null,
    };
    const working = composerPhase({
      state: 'running',
      hasText: true,
      steer: 'inject',
      project: 'ampsio',
      fresh: false,
      narrow: false,
    });

    it('sends while a plain Stop is on its way', async () => {
      const stopping = held();
      const onSend = vi.fn();
      renderWithTheme(
        <Held
          phase={PLAIN_STOP}
          onStop={() => stopping.promise}
          onSend={onSend}
          start={{ ...EMPTY_DRAFT, text: 'one more thing' }}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      fireEvent.keyDown(input(), { key: 'Enter' });
      await waitFor(() => {
        expect(onSend).toHaveBeenCalledTimes(1);
      });
      stopping.settle();
    });

    it('refuses a send while Stop and Redo carries the draft', async () => {
      const redoing = held();
      const onRedo = vi.fn(() => redoing.promise);
      const onSend = vi.fn();
      renderWithTheme(
        <Held
          phase={working}
          onRedo={onRedo}
          onSend={onSend}
          start={{ ...EMPTY_DRAFT, text: 'no, this' }}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Stop and Redo' }));
      fireEvent.keyDown(input(), { key: 'Enter' });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      redoing.settle();
      await waitFor(() => {
        expect(onRedo).toHaveBeenCalledTimes(1);
      });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('keeps Send busy until its own send settles, though a Stop settles first', async () => {
      const sending = held();
      const onSend = vi.fn(() => sending.promise);
      renderWithTheme(
        <Held
          phase={PLAIN_STOP}
          onSend={onSend}
          onStop={vi.fn()}
          start={{ ...EMPTY_DRAFT, text: 'once' }}
        />,
      );
      fireEvent.keyDown(input(), { key: 'Enter' });
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Stop' }).hasAttribute('data-loading')).toBe(
          false,
        );
      });
      fireEvent.keyDown(input(), { key: 'Enter' });
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('data-loading')).toBe(true);
      sending.settle();
      await waitFor(() => {
        expect((input() as HTMLTextAreaElement).value).toBe('');
      });
      expect(onSend).toHaveBeenCalledTimes(1);
    });
  });

  it('hands a failed send to the screen when it shows failures itself, keeping the draft', async () => {
    const onFailure = vi.fn();
    renderWithTheme(
      <Held
        onSend={vi.fn().mockRejectedValue(new Error('The database is locked'))}
        onFailure={onFailure}
        start={{ ...EMPTY_DRAFT, text: 'hi' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith('The database is locked');
    });
    expect(screen.queryByText('The database is locked')).toBeNull();
    expect((input() as HTMLTextAreaElement).value).toBe('hi');
  });

  it('with uploads, hands a dropped or picked file over at once and shows the screen’s refusals', () => {
    const onFiles = vi.fn();
    const onDismiss = vi.fn();
    const uploads = {
      accept: '.md,.pdf',
      onFiles,
      refused: ['notes.exe can’t be added: drop a Markdown, text, PDF or picture file'],
      onDismiss,
    };
    renderWithTheme(<Held uploads={uploads} attachLabel="Attach Files" />);
    const frame = input().closest('[data-composer-frame]');
    if (frame === null) throw new Error('the composer has no frame');
    const doc = new File(['# plan'], 'plan.md', { type: 'text/markdown' });
    fireEvent.dragEnter(frame, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByText('Drop Files to Add')).toBeTruthy();
    fireEvent.drop(frame, { dataTransfer: { types: ['Files'], files: [doc] } });
    expect(onFiles).toHaveBeenCalledWith([doc]);
    // The file went to the screen, not into the draft.
    expect(screen.queryByRole('list', { name: 'Pictures to send' })).toBeNull();
    expect(screen.getByLabelText('Choose files').getAttribute('accept')).toBe('.md,.pdf');
    expect(screen.getByRole('button', { name: 'Attach Files' })).toBeTruthy();
    expect(screen.getByText(/notes\.exe can’t be added/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
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

describe('Composer: Dictate', () => {
  it('shows no Dictate button outside the desktop shell', () => {
    renderWithTheme(<Held />);
    expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull();
  });

  it('focuses the input and asks the shell to start dictation', async () => {
    const asked: string[] = [];
    mockIPC((command) => {
      asked.push(command);
    });
    try {
      renderWithTheme(<Held />);
      expect(document.activeElement).not.toBe(input());
      fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
      await waitFor(() => {
        expect(asked).toEqual(['start_dictation']);
      });
      expect(document.activeElement).toBe(input());
    } finally {
      clearMocks();
    }
  });

  it('says why when the shell cannot start it', async () => {
    mockIPC(() => {
      throw new Error('Dictation is off in System Settings');
    });
    try {
      renderWithTheme(<Held />);
      fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
      expect(await screen.findByText('Dictation is off in System Settings')).toBeTruthy();
    } finally {
      clearMocks();
    }
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

  it('Enter picks a file as a chip without sending; the next Enter sends its path in the text and the list of mentions', async () => {
    const onSend = vi.fn();
    const lookup = vi.fn().mockResolvedValue(files);
    renderWithTheme(<Held onSend={onSend} mentions={{ files: lookup, commands: null }} />);
    type('@log');
    await screen.findAllByRole('option', { hidden: true });
    // Enter with the list open belongs to the list.
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => {
      expect((input() as HTMLTextAreaElement).value).toBe('@src/login.ts ');
    });
    type('@src/login.ts why');
    fireEvent.keyDown(input(), { key: 'Enter' });
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

  it('picking a command inserts it, and Enter then sends it as /name', async () => {
    const onSend = vi.fn();
    renderWithTheme(<Held onSend={onSend} mentions={{ commands }} />);
    type('/co');
    await screen.findByRole('option', { name: /compact/, hidden: true });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => {
      expect((input() as HTMLTextAreaElement).value).toBe('/compact ');
    });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith({ text: '/compact ', mentions: [], pictures: [] });
    });
  });
});

describe('Composer while Your folder is held', () => {
  const held = (onChoose = vi.fn(), onFileAsTasks = vi.fn()) => ({
    holders: 'the task ‘Bump vite’',
    onChoose,
    onFileAsTasks,
  });
  const typed = { text: 'fix the typo', mentions: [], pictures: [] };

  it('asks before a message runs, and sends nothing until a choice is made', () => {
    const onSend = vi.fn();
    const onChoose = vi.fn();
    renderWithTheme(<Held held={held(onChoose)} onSend={onSend} start={typed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Your folder is in use by the task ‘Bump vite’.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it.each([
    { button: 'Wait for It', choice: 'wait' },
    { button: 'Send Reading Only', choice: 'read_only' },
  ])('$button sends the draft with folder $choice and clears it', async ({ button, choice }) => {
    const onChoose = vi.fn();
    renderWithTheme(<Held held={held(onChoose)} start={typed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => {
      expect(onChoose).toHaveBeenCalledWith(typed, choice, 'send');
    });
    await waitFor(() => {
      expect((input() as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('picks Wait for It with ⌘↩ and cancels with Escape, leaving the draft', async () => {
    const onChoose = vi.fn();
    renderWithTheme(<Held held={held(onChoose)} start={typed} />);
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Your folder is in use' })).toBeNull();
    expect((input() as HTMLTextAreaElement).value).toBe('fix the typo');
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(onChoose).toHaveBeenCalledWith(typed, 'wait', 'send');
    });
  });

  it('files the standing request without sending the draft', async () => {
    const onFileAsTasks = vi.fn();
    const onChoose = vi.fn();
    renderWithTheme(<Held held={held(onChoose, onFileAsTasks)} start={typed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(screen.getByRole('button', { name: 'File as Tasks' }));
    await waitFor(() => {
      expect(onFileAsTasks).toHaveBeenCalled();
    });
    expect(onChoose).not.toHaveBeenCalled();
    expect((input() as HTMLTextAreaElement).value).toBe('fix the typo');
  });

  it('sends at once when nothing holds the folder', async () => {
    const onSend = vi.fn();
    renderWithTheme(<Held onSend={onSend} start={typed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(typed);
    });
    expect(screen.queryByRole('group', { name: 'Your folder is in use' })).toBeNull();
  });

  it('sends nothing from the choices once the composer is locked or cannot send', () => {
    const onChoose = vi.fn();
    function Cuts() {
      const [reason, setReason] = useState<string | null>(null);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setReason('Reconnecting… your message stays here.');
            }}
          >
            Cut
          </button>
          <Held held={held(onChoose)} disabledReason={reason} start={typed} />
        </>
      );
    }
    renderWithTheme(<Cuts />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cut' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wait for It' }));
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('drops the choices when the folder frees', () => {
    function Frees() {
      const [on, setOn] = useState(true);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOn(false);
            }}
          >
            Free
          </button>
          <Held {...(on ? { held: held() } : {})} start={typed} />
        </>
      );
    }
    renderWithTheme(<Frees />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('group', { name: 'Your folder is in use' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Free' }));
    expect(screen.queryByRole('group', { name: 'Your folder is in use' })).toBeNull();
  });
});
