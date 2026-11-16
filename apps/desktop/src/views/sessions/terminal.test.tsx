import type { ChatDto, ConversationItemDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatDto, chatServer } from '../../test/chat-fixtures';
import { builderItem, CLAUDE_CAPABILITIES } from '../../test/conversation-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { takeoverServer, type TakeoverServerOptions } from '../../test/takeover-fixtures';

// Open in Terminal and Hand Back over the daemon's routes (sessions UI spec §10).

const project = projectViewDto({ name: 'ampsio' });
const LINE = "/bin/sh -c 'exec ~/.10db/takeover/run'";

const writeText = vi.fn<(text: string) => Promise<void>>();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  localStorage.clear();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

function openChat(
  overrides: Parameters<typeof chatDto>[0] = {},
  terminal: TakeoverServerOptions = {},
  items: (chat: ChatDto) => ConversationItemDto[] = () => [],
) {
  const chat = chatDto({
    projectId: project.id,
    ...overrides,
    conversation: {
      capabilities: { ...CLAUDE_CAPABILITIES, label: 'Claude Code' },
      ...overrides.conversation,
    },
  });
  const served = chatServer({ chats: [chat], items: { [chat.conversationId]: items(chat) } });
  const taken = takeoverServer(served, terminal);
  server.use(
    ...taken.handlers,
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    ...served.handlers,
    ...baseHandlers(),
  );
  renderApp(`/sessions?chat=${chat.id}`);
  return { chat, served, taken };
}

const openPopover = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Open in Terminal' }));
  return screen.findByRole('dialog', { name: 'Open in Terminal' });
};

describe('Open in Terminal', () => {
  it.each([
    {
      name: 'a Claude chat',
      label: 'Claude Code',
      notes: ['Your folder is held until you hand back.', 'Auto mode is off in the terminal.'],
    },
    {
      name: 'a Codex chat',
      label: 'Codex',
      notes: ['Your folder is held until you hand back.', 'Codex gets no skills folders.'],
    },
  ])(
    'the popover for $name names the agent, the folder and what to know',
    async ({ label, notes }) => {
      openChat(
        { conversation: { capabilities: { ...CLAUDE_CAPABILITIES, label } } },
        { preview: { refusal: null, notes } },
      );
      const popover = await openPopover();
      expect(popover.textContent).toContain(`with ${label}'s own resume, in ${project.repoPath}`);
      expect(popover.textContent).toContain("outside 10db's sandbox");
      for (const note of notes) await within(popover).findByText(note);
      expect(within(popover).getByRole('button', { name: 'Open in Terminal' })).toHaveProperty(
        'disabled',
        false,
      );
    },
  );

  it('a refusal disables the button and says why', async () => {
    openChat({}, { preview: { refusal: 'Stop first', notes: [] } });
    const popover = await openPopover();
    await within(popover).findByText('Stop first');
    expect(within(popover).getByRole('button', { name: 'Open in Terminal' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('is offered only to an agent that can be taken over, and not to a chat in a terminal or sealed', async () => {
    openChat({
      conversation: { capabilities: { ...CLAUDE_CAPABILITIES, takeover: false } },
    });
    await screen.findByRole('button', { name: 'More session actions' });
    expect(screen.queryByRole('button', { name: 'Open in Terminal' })).toBeNull();
  });

  it('opens the chat: the daemon is asked once, the banner shows, and the strip says since when', async () => {
    const { taken } = openChat();
    const popover = await openPopover();
    await within(popover).findByText('Your folder is held until you hand back.');
    fireEvent.click(within(popover).getByRole('button', { name: 'Open in Terminal' }));
    const banner = await screen.findByRole('region', { name: 'In your terminal' });
    expect(taken.opened).toHaveLength(1);
    expect(banner.textContent).toContain("This runs outside 10db's sandbox");
    expect(await screen.findByText(/^Chat · in your terminal since \d\d:\d\d$/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open in Terminal' })).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('with Copy the Command the open puts the command on the clipboard', async () => {
    openChat({}, { app: 'copy', line: LINE });
    const popover = await openPopover();
    expect(popover.textContent).toContain('for zsh or bash');
    fireEvent.click(await within(popover).findByRole('button', { name: 'Copy the Command' }));
    await screen.findByRole('region', { name: 'In your terminal' });
    expect(writeText).toHaveBeenCalledWith(LINE);
  });

  it('a clipboard that refuses leaves the command in the banner to copy by hand', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    openChat({}, { app: 'copy', line: LINE });
    const popover = await openPopover();
    fireEvent.click(await within(popover).findByRole('button', { name: 'Copy the Command' }));
    const banner = await screen.findByRole('region', { name: 'In your terminal' });
    await within(banner).findByText(LINE);
  });

  it('a window that would not open says so and leaves the chat where it was', async () => {
    const words = "Terminal isn't installed or didn't open. Choose another in Settings > Sessions.";
    const { taken } = openChat({}, { openFails: words });
    const popover = await openPopover();
    fireEvent.click(await within(popover).findByRole('button', { name: 'Open in Terminal' }));
    await within(popover).findByText(words);
    expect(screen.queryByRole('region', { name: 'In your terminal' })).toBeNull();
    expect(taken.opened).toEqual([]);
  });

  it('the tab menu opens the popover on the chat', async () => {
    openChat();
    fireEvent.contextMenu(await screen.findByRole('tab'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in Terminal' }));
    await screen.findByRole('dialog', { name: 'Open in Terminal' });
  });
});

describe('a chat in the builder’s terminal', () => {
  const inTerminal = (items: (chat: ChatDto) => ConversationItemDto[] = () => []) =>
    openChat({ conversation: { state: 'taken_over' } }, { app: 'copy', line: LINE }, items);

  it('Hand Back asks first, then hands back, and the banner goes', async () => {
    const { taken } = inTerminal();
    await screen.findByRole('region', { name: 'In your terminal' });
    fireEvent.click(screen.getByRole('button', { name: 'Hand Back' }));
    const question = await screen.findByRole('dialog', { name: 'Hand Back' });
    within(question).getByText('Is Claude Code closed in your terminal?');
    expect(taken.handedBack).toEqual([]);
    fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Hand Back' })).toBeNull();
    });
    expect(taken.handedBack).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Hand Back' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Hand Back' })).getByRole('button', {
        name: 'Hand Back',
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'In your terminal' })).toBeNull();
    });
    expect(taken.handedBack).toHaveLength(1);
  });

  it('the tab says in your terminal', async () => {
    inTerminal();
    const tab = await screen.findByRole('tab');
    expect(tab.getAttribute('aria-label')).toMatch(/, in your terminal$/);
    expect(tab.getAttribute('data-state')).toBe('in_terminal');
  });

  it('Copy Command asks the daemon for the command and copies it', async () => {
    const { taken } = inTerminal();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Command' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(LINE);
    });
    expect(taken.commands).toHaveLength(1);
    await screen.findByRole('button', { name: 'Copied' });
  });

  it('Copy Command with a clipboard that refuses shows the command to copy by hand', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    inTerminal();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Command' }));
    const banner = await screen.findByRole('region', { name: 'In your terminal' });
    await within(banner).findByText(LINE);
  });

  it('shows the notes the open made, left-out servers among them', async () => {
    const notes = ['Left out of your terminal, as the agent can’t take them: docs.'];
    openChat({}, { openNotes: notes });
    const popover = await openPopover();
    fireEvent.click(await within(popover).findByRole('button', { name: 'Open in Terminal' }));
    const banner = await screen.findByRole('region', { name: 'In your terminal' });
    await within(banner).findByText(notes[0] ?? '');
  });

  it('focus is on Hand Back, and a message waits: the composer says so and the message holds', async () => {
    inTerminal((chat) => [
      { ...builderItem(chat.conversationId, 'Add a test'), deliveredAt: null },
    ]);
    const handBack = await screen.findByRole('button', { name: 'Hand Back' });
    await waitFor(() => {
      expect(document.activeElement).toBe(handBack);
    });
    expect(await screen.findByText('Held until you hand back')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message' }).getAttribute('placeholder')).toBe(
      'Held until you hand back…',
    );
  });

  it('a message typed meanwhile is sent as it is, with no choice about Your folder', async () => {
    const { served } = inTerminal();
    const box = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'next, the tests' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(served.messages).toHaveLength(1);
    });
    expect(served.messages[0]?.body).toEqual({ text: 'next, the tests' });
  });

  const askToArchive = async () => {
    await screen.findByRole('region', { name: 'In your terminal' });
    fireEvent.click(screen.getByRole('button', { name: 'More session actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    return screen.findByRole('dialog', { name: 'End takeover and archive?' });
  };

  it('Archive asks to end the takeover first, and Cancel archives nothing', async () => {
    const { served } = inTerminal();
    const ask = await askToArchive();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'End takeover and archive?' })).toBeNull();
    });
    expect(served.archived).toEqual([]);
  });

  it('End Takeover and Archive archives the chat', async () => {
    const { served } = inTerminal();
    const ask = await askToArchive();
    fireEvent.click(within(ask).getByRole('button', { name: 'End Takeover and Archive' }));
    await waitFor(() => {
      expect(served.archived).toHaveLength(1);
    });
  });
});
