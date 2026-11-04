import { mintId, type ShapeViewDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import {
  decisionProposal,
  goalProposal,
  looseTaskProposal,
  questionProposal,
  shapeDto,
  shapeMessageDto,
  shapeViewDto,
} from '../../test/shape-fixtures';

// Shape spec §4 D1: under 1100 px the Proposed sidebar is a drawer, and each count in the bar's
// summary line opens it at that count's section.

const project = projectViewDto();
const realObserver = window.ResizeObserver;

/** The width every observed element has. Under 1100 px the split pane chooses the drawer layout. */
let contentWidth = 900;
const watching = new Set<SizedObserver>();

/** Reports `contentWidth` on observing, and again when `resizeTo` changes it. */
class SizedObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;
  private readonly targets = new Set<Element>();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    this.targets.add(target);
    watching.add(this);
    this.report();
  }
  report(): void {
    const width = contentWidth;
    const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 600, right: width, width, height: 600 };
    const box = [{ inlineSize: width, blockSize: 600 }];
    const entries = [...this.targets].map((target) => ({
      target,
      contentRect: { ...rect, toJSON: () => rect },
      borderBoxSize: box,
      contentBoxSize: box,
      devicePixelContentBoxSize: box,
    }));
    this.callback(entries, this);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    watching.delete(this);
  }
}

function resizeTo(width: number): void {
  contentWidth = width;
  for (const observer of watching) observer.report();
}

beforeEach(() => {
  contentWidth = 900;
  watching.clear();
  window.ResizeObserver = SizedObserver;
});
afterEach(() => {
  window.ResizeObserver = realObserver;
});

function openNarrow(view: ShapeViewDto): ReturnType<typeof renderApp> {
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([view.shape])),
    http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(view)),
    ...baseHandlers(),
  );
  return renderApp(`/shape/${view.shape.id}`);
}

describe('Shape: the drawer layout', () => {
  const base = shapeDto({
    projectId: project.id,
    state: 'proposed',
    proposeUnlocked: true,
    round: 1,
  });
  const view = shapeViewDto({
    shape: base,
    messages: [shapeMessageDto(base.id)],
    proposals: [
      goalProposal('brainstorm', ['one', 'two']),
      looseTaskProposal('density', { title: 'Compact card density' }),
      looseTaskProposal('scrollbars', { title: 'Thin board scrollbars' }),
      decisionProposal('replaces-adopt'),
      questionProposal('ship-date'),
    ],
  });

  it('opens the drawer at the first row of the section a count names', async () => {
    openNarrow(view);
    const bar = await screen.findByRole('group', { name: 'Summary' });
    expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
    fireEvent.click(within(bar).getByRole('button', { name: '2 loose' }));
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    const first = within(sidebar).getByRole('button', { name: /^Compact card density/ });
    expect(document.activeElement).toBe(first);
  });

  it('moves to another section when the drawer is already open', async () => {
    openNarrow(view);
    const bar = await screen.findByRole('group', { name: 'Summary' });
    fireEvent.click(within(bar).getByRole('button', { name: '2 loose' }));
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    fireEvent.click(within(bar).getByRole('button', { name: '1 goal' }));
    const goal = within(sidebar).getByRole('button', { name: /^Brainstorm chat/ });
    expect(document.activeElement).toBe(goal);
  });

  it('opens at a converted row when only loose tasks were converted and no goal exists', async () => {
    const done = {
      state: 'accepted' as const,
      converted: { goalId: null, taskIds: [mintId('Task')], decisionId: null },
    };
    openNarrow(
      shapeViewDto({
        shape: base,
        messages: [shapeMessageDto(base.id)],
        proposals: [
          looseTaskProposal('density', { title: 'Compact card density', ...done }),
          looseTaskProposal('scrollbars', { title: 'Thin board scrollbars', ...done }),
        ],
      }),
    );
    const bar = await screen.findByRole('group', { name: 'Summary' });
    fireEvent.click(within(bar).getByRole('button', { name: '2 converted' }));
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    const first = within(sidebar).getByRole('button', { name: /^Compact card density/ });
    expect(document.activeElement).toBe(first);
  });

  it('lifts the round filter in an open drawer to focus a converted row', async () => {
    const done = {
      state: 'accepted' as const,
      converted: { goalId: null, taskIds: [mintId('Task')], decisionId: null },
    };
    openNarrow(
      shapeViewDto({
        shape: { ...base, round: 2 },
        messages: [shapeMessageDto(base.id)],
        proposals: [
          looseTaskProposal('density', { title: 'Compact card density', ...done }),
          goalProposal('brainstorm', ['one'], { round: 2, mark: 'new' }),
        ],
      }),
    );
    const bar = await screen.findByRole('group', { name: 'Summary' });
    fireEvent.click(within(bar).getByRole('button', { name: '1 goal' }));
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    const filter = within(sidebar).getByRole('button', { name: '1 change in round 2' });
    fireEvent.click(filter);
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(bar).getByRole('button', { name: '1 converted' }));
    expect(filter.getAttribute('aria-pressed')).toBe('false');
    const row = within(sidebar).getByRole('button', { name: /^Compact card density/ });
    expect(document.activeElement).toBe(row);
  });

  it('opens at the top, with no jump left over, from the Proposed button', async () => {
    openNarrow(view);
    const bar = await screen.findByRole('group', { name: 'Summary' });
    fireEvent.click(within(bar).getByRole('button', { name: '2 loose' }));
    await screen.findByRole('region', { name: 'Proposed' });
    const toggle = screen.getByRole('button', { name: 'Proposed' });
    fireEvent.click(toggle);
    expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
    fireEvent.click(toggle);
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    expect(sidebar.contains(document.activeElement)).toBe(false);
  });

  // The drawer is laid over the bar's right end, where the Proposed button is, so a mouse user
  // needs a close control inside it.
  it('closes from a Close button in the drawer and leaves focus on the Proposed button', async () => {
    openNarrow(view);
    const bar = await screen.findByRole('group', { name: 'Summary' });
    fireEvent.click(within(bar).getByRole('button', { name: '2 loose' }));
    await screen.findByRole('region', { name: 'Proposed' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Proposed' }));
    expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Proposed' }));
  });

  it('closes on Esc, wherever focus is, and leaves focus on the Proposed button', async () => {
    openNarrow(view);
    fireEvent.click(await screen.findByRole('button', { name: 'Proposed' }));
    await screen.findByRole('region', { name: 'Proposed' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Proposed' }));
  });

  it('leaves Esc to an open menu in the drawer', async () => {
    openNarrow(view);
    fireEvent.click(await screen.findByRole('button', { name: 'Proposed' }));
    await screen.findByRole('region', { name: 'Proposed' });
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    menu.remove();
    expect(screen.getByRole('region', { name: 'Proposed' })).toBeTruthy();
  });

  it('leaves Esc to an open row editor, and the next Esc closes the drawer', async () => {
    openNarrow(view);
    fireEvent.click(await screen.findByRole('button', { name: 'Proposed' }));
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Edit Compact card density' }));
    const form = await within(sidebar).findByRole('form', { name: 'Edit row' });
    fireEvent.keyDown(within(form).getByLabelText('Title'), { key: 'Escape' });
    expect(within(sidebar).queryByRole('form', { name: 'Edit row' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Proposed' })).toBe(sidebar);
    const row = within(sidebar).getByRole('button', { name: /^Compact card density/ });
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Proposed' }));
  });

  it('stops a running turn only on the Esc after the editor and the drawer have closed', async () => {
    const stops: string[] = [];
    server.use(
      http.post(daemonUrl('/shapes/:shapeId/stop'), ({ params }) => {
        stops.push(String(params['shapeId']));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    openNarrow({
      ...view,
      turn: {
        running: true,
        queued: 0,
        proposing: false,
        rehearsing: false,
        waitingForUpdate: false,
      },
    });
    await screen.findByRole('button', { name: 'Stop' });
    fireEvent.click(screen.getByRole('button', { name: 'Proposed' }));
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Edit Compact card density' }));
    const form = await within(sidebar).findByRole('form', { name: 'Edit row' });
    fireEvent.keyDown(within(form).getByLabelText('Title'), { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
    expect(stops).toEqual([]);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(stops).toEqual([view.shape.id]);
    });
  });

  it('leaves Esc to the row editor from its Cancel button too', async () => {
    openNarrow(view);
    fireEvent.click(await screen.findByRole('button', { name: 'Proposed' }));
    const sidebar = await screen.findByRole('region', { name: 'Proposed' });
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Edit Compact card density' }));
    const form = await within(sidebar).findByRole('form', { name: 'Edit row' });
    fireEvent.keyDown(within(form).getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(within(sidebar).queryByRole('form', { name: 'Edit row' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Proposed' })).toBe(sidebar);
  });

  describe('Why?', () => {
    // The transcript scrolls through its virtual list, which writes Element.scrollTo. jsdom has none.
    beforeEach(() => {
      Element.prototype.scrollTo = vi.fn();
    });
    afterEach(() => {
      // @ts-expect-error jsdom has none; put that back.
      delete Element.prototype.scrollTo;
    });

    it('closes the drawer and leaves focus on the Proposed button, from the W key', async () => {
      openNarrow(view);
      fireEvent.click(await screen.findByRole('button', { name: 'Proposed' }));
      const sidebar = await screen.findByRole('region', { name: 'Proposed' });
      const row = within(sidebar).getByRole('button', { name: /^Compact card density/ });
      row.focus();
      fireEvent.keyDown(row, { key: 'w' });
      expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Proposed' }));
    });

    it('closes the drawer and leaves focus on the Proposed button, from the menu', async () => {
      openNarrow(view);
      fireEvent.click(await screen.findByRole('button', { name: 'Proposed' }));
      const sidebar = await screen.findByRole('region', { name: 'Proposed' });
      fireEvent.click(
        within(sidebar).getByRole('button', { name: 'Actions for Compact card density' }),
      );
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Why?' }));
      expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
      await waitFor(() => {
        expect(screen.queryByRole('menu')).toBeNull();
      });
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Proposed' }));
    });
  });
});

// A screen is first drawn at width 0, which reads as the split layout, and takes its real layout a
// frame later. The default window is under 1100 px, so every conversation opens through that change.
describe('Shape: the conversation across a layout change', () => {
  const shape = shapeDto({ projectId: project.id, state: 'proposed', proposeUnlocked: true });
  const view = shapeViewDto({ shape, messages: [shapeMessageDto(shape.id)], proposals: [] });
  const text = 'Move density ahead of the scrollbars.';

  const waiting = () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { held, release };
  };
  const refused = (message: string) =>
    HttpResponse.json({ error: 'invalid', message }, { status: 400 });
  const restarting = () =>
    HttpResponse.json(
      { error: 'unavailable', message: 'The daemon is restarting' },
      { status: 503 },
    );
  const uploaded = () =>
    HttpResponse.json(
      {
        id: mintId('ShapeFile'),
        shapeId: shape.id,
        name: 'brief.md',
        mediaType: 'text/markdown',
        size: 4,
        storedPath: '/data/shapes/x/files/brief.md',
        createdAt: '2026-11-02T12:00:00.000Z',
      },
      { status: 201 },
    );
  const serve = (...overrides: RequestHandler[]): void => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([shape])),
      http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(view)),
      http.post(daemonUrl('/projects/:projectId/shapes'), () =>
        HttpResponse.json(shape, { status: 201 }),
      ),
      ...overrides,
      ...baseHandlers(),
    );
  };
  /** The new-conversation screen once it has its project and has measured itself. */
  const onNewConversation = async (): Promise<HTMLElement> => {
    await screen.findByRole('list', { name: 'Recent conversations' });
    if (contentWidth < 1100) await screen.findByRole('button', { name: 'Proposed' });
    return screen.getByRole('textbox', { name: 'Message' });
  };
  const send = (input: HTMLElement): void => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
  };
  const drop = (input: HTMLElement): void => {
    const files = [new File(['# Hi'], 'brief.md', { type: 'text/markdown' })];
    fireEvent.drop(input, { dataTransfer: { files, types: ['Files'] } });
  };
  /** The opened conversation has measured itself: only it has New, and only the drawer has the bar. */
  const openedInTheDrawerLayout = async (): Promise<void> => {
    await screen.findByRole('link', { name: 'New' });
    await screen.findByRole('button', { name: 'Proposed' });
  };

  it('keeps the reason and the text of a send that failed before the upload opened it', async () => {
    const upload = waiting();
    serve(
      http.post(daemonUrl('/shapes/:shapeId/messages'), restarting),
      http.post(daemonUrl('/shapes/:shapeId/files'), async () => {
        await upload.held;
        return uploaded();
      }),
    );
    renderApp('/shape');
    const input = await onNewConversation();
    drop(input);
    send(input);
    expect(await screen.findByText('The daemon is restarting')).toBeTruthy();
    upload.release();
    await openedInTheDrawerLayout();
    expect(screen.getByText('The daemon is restarting')).toBeTruthy();
    const kept = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    expect(kept.value).toBe(text);
  });

  it('keeps the reason and the text of a send that failed after the builder left /shape', async () => {
    const message = waiting();
    serve(
      http.post(daemonUrl('/shapes/:shapeId/messages'), async () => {
        await message.held;
        return restarting();
      }),
    );
    const { router } = renderApp('/shape');
    const input = await onNewConversation();
    send(input);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('data-loading')).toBe(true);
    });
    await router.navigate({ to: '/' });
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    });
    message.release();
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    });
    await router.navigate({ to: '/shape/$shapeId', params: { shapeId: shape.id } });
    await openedInTheDrawerLayout();
    expect(await screen.findByText('The daemon is restarting')).toBeTruthy();
    const kept = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    expect(kept.value).toBe(text);
  });

  it('keeps the reason of a dropped file the daemon refused', async () => {
    serve(
      http.post(daemonUrl('/shapes/:shapeId/files'), () =>
        refused('brief.md isn’t really Markdown'),
      ),
    );
    renderApp('/shape');
    drop(await onNewConversation());
    await openedInTheDrawerLayout();
    expect(screen.getByText('brief.md isn’t really Markdown')).toBeTruthy();
  });

  it('keeps the reason of a refused drop while a send is still on its way', async () => {
    const message = waiting();
    serve(
      http.post(daemonUrl('/shapes/:shapeId/files'), () =>
        refused('brief.md isn’t really Markdown'),
      ),
      http.post(daemonUrl('/shapes/:shapeId/messages'), async () => {
        await message.held;
        return HttpResponse.json(shapeMessageDto(shape.id), { status: 202 });
      }),
    );
    renderApp('/shape');
    const input = await onNewConversation();
    send(input);
    drop(input);
    await openedInTheDrawerLayout();
    expect(screen.getByText('brief.md isn’t really Markdown')).toBeTruthy();
    message.release();
  });

  it('opens the conversation of a send the window was resized across', async () => {
    contentWidth = 1200;
    const message = waiting();
    serve(
      http.post(daemonUrl('/shapes/:shapeId/messages'), async () => {
        await message.held;
        return HttpResponse.json(shapeMessageDto(shape.id), { status: 202 });
      }),
    );
    const { router } = renderApp('/shape');
    const input = await onNewConversation();
    send(input);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('data-loading')).toBe(true);
    });
    resizeTo(900);
    await screen.findByRole('button', { name: 'Proposed' });
    message.release();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/shape/${shape.id}`);
    });
  });

  it('keeps the input, and what is typed in it, when the window crosses the drawer width', async () => {
    contentWidth = 1200;
    serve();
    renderApp('/shape');
    const input = await onNewConversation();
    fireEvent.change(input, { target: { value: text } });
    resizeTo(900);
    await screen.findByRole('button', { name: 'Proposed' });
    expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
    resizeTo(1200);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Proposed' })).toBeNull();
    });
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }).value).toBe(text);
  });
});
