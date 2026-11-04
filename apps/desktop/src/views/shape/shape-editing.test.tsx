import { mintId, type ShapeViewDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import {
  goalProposal,
  looseTaskProposal,
  shapeDto,
  shapeMessageDto,
  shapeViewDto,
} from '../../test/shape-fixtures';

// Shape spec §6 Editing, What changed and why, and §5.4 Dropped files, as the builder meets them.

const project = projectViewDto();
const inProject = { projectId: project.id };

function serve(...overrides: (RequestHandler | WebSocketHandler)[]): void {
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    ...overrides,
    ...baseHandlers(),
  );
}

function conversation(view: ShapeViewDto): RequestHandler[] {
  return [
    http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([view.shape])),
    http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(view)),
  ];
}

function proposed(
  proposals: ShapeViewDto['proposals'],
  extra: Partial<ShapeViewDto> = {},
  round = 2,
): ShapeViewDto {
  const shape = shapeDto({ ...inProject, state: 'proposed', proposeUnlocked: true, round });
  return shapeViewDto({ shape, messages: [shapeMessageDto(shape.id)], proposals, ...extra });
}

const open = (view: ShapeViewDto) => renderApp(`/shape/${view.shape.id}`);

/** Records each request the daemon gets at `path`, answering `status`. */
function recording(method: 'post' | 'patch', path: string, status = 204) {
  const bodies: unknown[] = [];
  const handler = http[method](daemonUrl(path), async ({ request }) => {
    bodies.push(await request.json().catch(() => null));
    return new HttpResponse(null, { status });
  });
  return { bodies, handler };
}

const rowMenu = async (title: string, item: string): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${title}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
};

describe('editing a row', () => {
  it('opens the editor, sends only what changed, and closes', async () => {
    const view = proposed([looseTaskProposal('density', { title: 'Compact card density' })]);
    const patch = recording('patch', '/shapes/:shapeId/proposals/:proposalId');
    serve(...conversation(view), patch.handler);
    open(view);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Compact card density' }));
    const form = await screen.findByRole('form', { name: 'Edit row' });
    const save = within(form).getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Denser cards' } });
    fireEvent.change(within(form).getByLabelText('Size'), { target: { value: 'L' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => {
      expect(patch.bodies).toEqual([{ fields: { title: 'Denser cards', size: 'L' } }]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'Edit row' })).toBeNull();
    });
  });

  it('edits a goal’s task by its path', async () => {
    const view = proposed([goalProposal('g', ['one', 'two'])]);
    const patch = recording('patch', '/shapes/:shapeId/proposals/:proposalId');
    serve(...conversation(view), patch.handler);
    open(view);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Brainstorm chat in 10db' }));
    const form = await screen.findByRole('form', { name: 'Edit row' });
    fireEvent.change(within(form).getByLabelText('Task two: size'), { target: { value: 'L' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patch.bodies).toEqual([{ fields: { 'tasks.two.size': 'L' } }]);
    });
  });

  it('cancels with Esc, sending nothing', async () => {
    const view = proposed([looseTaskProposal('density', { title: 'Compact card density' })]);
    const patch = recording('patch', '/shapes/:shapeId/proposals/:proposalId');
    serve(...conversation(view), patch.handler);
    open(view);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Compact card density' }));
    const form = await screen.findByRole('form', { name: 'Edit row' });
    fireEvent.change(within(form).getByLabelText('Title'), {
      target: { value: 'Changed my mind' },
    });
    fireEvent.keyDown(within(form).getByLabelText('Title'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'Edit row' })).toBeNull();
    });
    expect(patch.bodies).toEqual([]);
  });

  it('shows a pin on an edited row, and the daemon’s reason when an edit is refused', async () => {
    const view = proposed([
      looseTaskProposal('density', { title: 'Compact card density', pinned: ['size'] }),
    ]);
    serve(
      ...conversation(view),
      http.patch(daemonUrl('/shapes/:shapeId/proposals/:proposalId'), () =>
        HttpResponse.json(
          { error: 'invalid', message: 'That edit does not fit a task' },
          { status: 400 },
        ),
      ),
    );
    open(view);
    expect(await screen.findByRole('img', { name: 'Pinned' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Compact card density' }));
    const form = await screen.findByRole('form', { name: 'Edit row' });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'X' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('That edit does not fit a task')).toBeTruthy();
  });
});

describe('pinning, restoring and dropping', () => {
  it('pins an unpinned row, unpins a pinned one, and drops a row', async () => {
    const view = proposed([
      looseTaskProposal('a', { title: 'Alpha task' }),
      looseTaskProposal('b', { title: 'Beta task', pinned: ['title'] }),
      looseTaskProposal('c', { title: 'Gamma task' }),
    ]);
    const restore = recording('post', '/shapes/:shapeId/proposals/:proposalId/restore');
    const unpin = recording('post', '/shapes/:shapeId/proposals/:proposalId/unpin');
    const drop = recording('post', '/shapes/:shapeId/proposals/:proposalId/drop');
    serve(...conversation(view), restore.handler, unpin.handler, drop.handler);
    open(view);
    await rowMenu('Alpha task', 'Pin');
    await waitFor(() => {
      expect(restore.bodies).toHaveLength(1);
    });
    await rowMenu('Beta task', 'Unpin');
    await waitFor(() => {
      expect(unpin.bodies).toEqual([{}]);
    });
    await rowMenu('Gamma task', 'Drop');
    await waitFor(() => {
      expect(drop.bodies).toHaveLength(1);
    });
  });

  it('pins with P and edits with E from the row', async () => {
    const view = proposed([looseTaskProposal('a', { title: 'Alpha task' })]);
    const restore = recording('post', '/shapes/:shapeId/proposals/:proposalId/restore');
    serve(...conversation(view), restore.handler);
    open(view);
    const row = await screen.findByRole('button', { name: /^Alpha task/ });
    row.focus();
    fireEvent.keyDown(row, { key: 'p' });
    await waitFor(() => {
      expect(restore.bodies).toHaveLength(1);
    });
    fireEvent.keyDown(row, { key: 'e' });
    expect(await screen.findByRole('form', { name: 'Edit row' })).toBeTruthy();
  });

  it('brings a row back from Earlier with Restore', async () => {
    const view = proposed([
      looseTaskProposal('old', { title: 'Old idea', state: 'superseded', mark: 'moved' }),
      looseTaskProposal('density', { title: 'Compact card density' }),
    ]);
    const restore = recording('post', '/shapes/:shapeId/proposals/:proposalId/restore');
    serve(...conversation(view), restore.handler);
    open(view);
    fireEvent.click(await screen.findByRole('button', { name: /Earlier/ }));
    expect(await screen.findByText('moved to Earlier')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Old idea/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => {
      expect(restore.bodies).toHaveLength(1);
    });
  });

  it('does not offer to edit or drop a converted row', async () => {
    const view = proposed([
      looseTaskProposal('done', {
        title: 'Converted task',
        state: 'accepted',
        converted: { goalId: null, taskIds: [mintId('Task')], decisionId: null },
      }),
    ]);
    serve(...conversation(view));
    open(view);
    await screen.findByRole('button', { name: /^Converted task/ });
    expect(screen.queryByRole('button', { name: 'Edit Converted task' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Converted task' }));
    expect(await screen.findByRole('menuitem', { name: 'Why?' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Drop' })).toBeNull();
  });
});

describe('what changed, and why', () => {
  const marked = () =>
    proposed([
      looseTaskProposal('a', { title: 'Alpha task', mark: 'new', round: 2 }),
      looseTaskProposal('b', { title: 'Beta task', mark: 'changed', round: 2 }),
      looseTaskProposal('c', { title: 'Gamma task' }),
    ]);

  it('marks each row the latest round created or changed, and no other', async () => {
    const view = marked();
    serve(...conversation(view));
    open(view);
    await screen.findByRole('button', { name: /^Alpha task/ });
    const rows = screen.getAllByRole('listitem');
    const text = (title: string) =>
      rows.find((r) => r.textContent.includes(title))?.textContent ?? '';
    expect(text('Alpha task')).toContain('new');
    expect(text('Beta task')).toContain('changed');
    expect(text('Gamma task')).not.toMatch(/\b(new|changed)\b/);
  });

  it('filters the list to the round’s changes and back', async () => {
    const view = marked();
    serve(...conversation(view));
    open(view);
    const filter = await screen.findByRole('button', { name: '2 changes in round 2' });
    fireEvent.click(filter);
    expect(screen.queryByRole('button', { name: /^Gamma task/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Alpha task/ })).toBeTruthy();
    fireEvent.click(filter);
    expect(await screen.findByRole('button', { name: /^Gamma task/ })).toBeTruthy();
  });

  it('says nothing when the round changed nothing', async () => {
    const view = proposed([looseTaskProposal('a', { title: 'Alpha task' })]);
    serve(...conversation(view));
    open(view);
    await screen.findByRole('button', { name: /^Alpha task/ });
    expect(screen.queryByRole('button', { name: /changes? in round/ })).toBeNull();
  });

  describe('Why?', () => {
    // The transcript scrolls through its virtual list, which writes Element.scrollTo. jsdom has none.
    const scrolled = vi.fn();
    beforeEach(() => {
      Element.prototype.scrollTo = scrolled;
    });
    afterEach(() => {
      scrolled.mockClear();
      // @ts-expect-error jsdom has none; put that back.
      delete Element.prototype.scrollTo;
    });

    function withSources() {
      const shape = shapeDto({ ...inProject, state: 'proposed', proposeUnlocked: true, round: 1 });
      const first = shapeMessageDto(shape.id, { body: 'Move density ahead.' });
      const second = shapeMessageDto(shape.id, { body: 'And thin the scrollbars.' });
      return {
        first,
        second,
        view: shapeViewDto({
          shape,
          messages: [first, second],
          proposals: [
            looseTaskProposal('bars', { title: 'Thin scrollbars', sourceMessageIds: [second.id] }),
          ],
        }),
      };
    }
    const highlighted = (): string[] =>
      [...document.querySelectorAll('[data-highlighted]')].map((el) => el.textContent);

    it('scrolls to the messages a row came from and highlights them, and Esc lets go', async () => {
      const { view } = withSources();
      serve(...conversation(view));
      open(view);
      fireEvent.click(await screen.findByRole('button', { name: 'Actions for Thin scrollbars' }));
      const why = await screen.findByRole('menuitem', { name: 'Why?' });
      // Mounting already scrolled to the end through the same scrollTo; only the press counts.
      scrolled.mockClear();
      fireEvent.click(why);
      await waitFor(() => {
        expect(highlighted()).toEqual(['And thin the scrollbars.']);
      });
      expect(scrolled).toHaveBeenCalled();
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => {
        expect(highlighted()).toEqual([]);
      });
    });

    it('opens from W on the row, and from the opened row’s own button', async () => {
      const { view } = withSources();
      serve(...conversation(view));
      open(view);
      const row = await screen.findByRole('button', { name: /^Thin scrollbars/ });
      row.focus();
      fireEvent.keyDown(row, { key: 'w' });
      await waitFor(() => {
        expect(highlighted()).toEqual(['And thin the scrollbars.']);
      });
      // The sidebar stays beside the chat here, so focus stays on the row; only a drawer moves it.
      expect(document.activeElement).toBe(row);
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(row);
      fireEvent.click(await screen.findByRole('button', { name: 'Why?' }));
      await waitFor(() => {
        expect(highlighted()).toEqual(['And thin the scrollbars.']);
      });
    });
  });
});

describe('dropping files', () => {
  const upload = () => {
    const seen: { name: string | null; type: string | null; text: string }[] = [];
    const handler = http.post(daemonUrl('/shapes/:shapeId/files'), async ({ request }) => {
      const url = new URL(request.url);
      seen.push({
        name: url.searchParams.get('name'),
        type: request.headers.get('content-type'),
        text: await request.text(),
      });
      return HttpResponse.json(
        {
          id: mintId('ShapeFile'),
          shapeId: mintId('Shape'),
          name: url.searchParams.get('name'),
          mediaType: 'text/markdown',
          size: 4,
          storedPath: '/data/shapes/x/files/brief.md',
          createdAt: '2026-11-02T12:00:00.000Z',
        },
        { status: 201 },
      );
    });
    return { seen, handler };
  };
  const dropOn = (target: HTMLElement, files: File[]): void => {
    fireEvent.drop(target, { dataTransfer: { files, types: ['Files'] } });
  };

  it('uploads a dropped Markdown file with its name and type', async () => {
    const view = proposed([], {}, 0);
    const up = upload();
    serve(...conversation(view), up.handler);
    open(view);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    dropOn(input, [new File(['# Hi'], 'brief.md', { type: 'text/markdown' })]);
    await waitFor(() => {
      expect(up.seen).toEqual([{ name: 'brief.md', type: 'text/markdown', text: '# Hi' }]);
    });
  });

  it('puts a file dropped while the first send is still creating the conversation into that conversation', async () => {
    const view = proposed([], {}, 0);
    let created = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted: string[] = [];
    const uploaded: string[] = [];
    serve(
      ...conversation(view),
      // Every create makes its own conversation, so a second create shows as a different id.
      http.post(daemonUrl('/projects/:projectId/shapes'), async () => {
        created += 1;
        const made = created === 1 ? view.shape : shapeDto({ ...inProject, state: 'listening' });
        await held;
        return HttpResponse.json(made, { status: 201 });
      }),
      http.post(daemonUrl('/shapes/:shapeId/messages'), ({ params }) => {
        posted.push(String(params['shapeId']));
        return HttpResponse.json(shapeMessageDto(view.shape.id), { status: 202 });
      }),
      http.post(daemonUrl('/shapes/:shapeId/files'), ({ params, request }) => {
        uploaded.push(String(params['shapeId']));
        return HttpResponse.json(
          {
            id: mintId('ShapeFile'),
            shapeId: view.shape.id,
            name: new URL(request.url).searchParams.get('name'),
            mediaType: 'text/markdown',
            size: 4,
            storedPath: '/data/shapes/x/files/brief.md',
            createdAt: '2026-11-02T12:00:00.000Z',
          },
          { status: 201 },
        );
      }),
    );
    renderApp('/shape');
    const input = await screen.findByRole('textbox', { name: 'Message' });
    await screen.findByRole('list', { name: 'Recent conversations' });
    fireEvent.change(input, { target: { value: 'Move density ahead of the scrollbars.' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(created).toBe(1);
    });
    dropOn(input, [new File(['# Hi'], 'brief.md', { type: 'text/markdown' })]);
    release();
    await waitFor(() => {
      expect(posted).toHaveLength(1);
      expect(uploaded).toHaveLength(1);
    });
    expect(uploaded).toEqual(posted);
    expect(posted).toEqual([view.shape.id]);
  });

  describe('when a send and a drop overlap on the new-conversation screen', () => {
    const waiting = () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { held, release };
    };
    const fileDto = (view: ShapeViewDto) => ({
      id: mintId('ShapeFile'),
      shapeId: view.shape.id,
      name: 'brief.md',
      mediaType: 'text/markdown',
      size: 4,
      storedPath: '/data/shapes/x/files/brief.md',
      createdAt: '2026-11-02T12:00:00.000Z',
    });
    const created = (view: ShapeViewDto) =>
      http.post(daemonUrl('/projects/:projectId/shapes'), () =>
        HttpResponse.json(view.shape, { status: 201 }),
      );
    const accepted = (view: ShapeViewDto) =>
      http.post(daemonUrl('/shapes/:shapeId/messages'), () =>
        HttpResponse.json(shapeMessageDto(view.shape.id), { status: 202 }),
      );
    const refused = (message: string) =>
      HttpResponse.json({ error: 'invalid', message }, { status: 400 });
    const send = (input: HTMLElement, text: string): void => {
      fireEvent.change(input, { target: { value: text } });
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    };
    const brief = () => [new File(['# Hi'], 'brief.md', { type: 'text/markdown' })];

    it('shows an upload that fails after the send opened the conversation, in that conversation', async () => {
      const view = proposed([], {}, 0);
      const upload = waiting();
      serve(
        ...conversation(view),
        created(view),
        accepted(view),
        http.post(daemonUrl('/shapes/:shapeId/files'), async () => {
          await upload.held;
          return refused('brief.md isn’t really Markdown');
        }),
      );
      const { router } = renderApp('/shape');
      const input = await screen.findByRole('textbox', { name: 'Message' });
      await screen.findByRole('list', { name: 'Recent conversations' });
      dropOn(input, brief());
      send(input, 'Move density ahead of the scrollbars.');
      await waitFor(() => {
        expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
      });
      upload.release();
      expect(await screen.findByText('brief.md isn’t really Markdown')).toBeTruthy();
      expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
    });

    it('shows a send that fails after the upload opened the conversation, and keeps the text', async () => {
      const view = proposed([], {}, 0);
      const message = waiting();
      serve(
        ...conversation(view),
        created(view),
        http.post(daemonUrl('/shapes/:shapeId/files'), () =>
          HttpResponse.json(fileDto(view), { status: 201 }),
        ),
        http.post(daemonUrl('/shapes/:shapeId/messages'), async () => {
          await message.held;
          return HttpResponse.json(
            { error: 'unavailable', message: 'The daemon is restarting' },
            { status: 503 },
          );
        }),
      );
      const { router } = renderApp('/shape');
      const input = await screen.findByRole('textbox', { name: 'Message' });
      await screen.findByRole('list', { name: 'Recent conversations' });
      send(input, 'Move density ahead of the scrollbars.');
      dropOn(input, brief());
      await waitFor(() => {
        expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
      });
      message.release();
      expect(await screen.findByText('The daemon is restarting')).toBeTruthy();
      const kept = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
      expect(kept.value).toBe('Move density ahead of the scrollbars.');
    });

    it('keeps the text and the reason of a send that failed before the upload opened the conversation', async () => {
      const view = proposed([], {}, 0);
      const upload = waiting();
      serve(
        ...conversation(view),
        created(view),
        http.post(daemonUrl('/shapes/:shapeId/messages'), () =>
          HttpResponse.json(
            { error: 'unavailable', message: 'The daemon is restarting' },
            { status: 503 },
          ),
        ),
        http.post(daemonUrl('/shapes/:shapeId/files'), async () => {
          await upload.held;
          return HttpResponse.json(fileDto(view), { status: 201 });
        }),
      );
      const { router } = renderApp('/shape');
      const input = await screen.findByRole('textbox', { name: 'Message' });
      await screen.findByRole('list', { name: 'Recent conversations' });
      dropOn(input, brief());
      send(input, 'Move density ahead of the scrollbars.');
      expect(await screen.findByText('The daemon is restarting')).toBeTruthy();
      expect(router.state.location.pathname).toBe('/shape');
      upload.release();
      await waitFor(() => {
        expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
      });
      expect(await screen.findByText('The daemon is restarting')).toBeTruthy();
      const kept = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
      expect(kept.value).toBe('Move density ahead of the scrollbars.');
    });

    describe('what is in the input when the upload opens the conversation', () => {
      const failingSend = (view: ShapeViewDto, upload: ReturnType<typeof waiting>) => [
        ...conversation(view),
        created(view),
        http.post(daemonUrl('/shapes/:shapeId/messages'), () =>
          HttpResponse.json(
            { error: 'unavailable', message: 'The daemon is restarting' },
            { status: 503 },
          ),
        ),
        http.post(daemonUrl('/shapes/:shapeId/files'), async () => {
          await upload.held;
          return HttpResponse.json(fileDto(view), { status: 201 });
        }),
      ];

      it('carries text typed after the drop, without a send, into the conversation', async () => {
        const view = proposed([], {}, 0);
        const upload = waiting();
        serve(...failingSend(view, upload));
        const { router } = renderApp('/shape');
        const input = await screen.findByRole('textbox', { name: 'Message' });
        await screen.findByRole('list', { name: 'Recent conversations' });
        dropOn(input, brief());
        fireEvent.change(input, { target: { value: 'Typed while it uploaded.' } });
        upload.release();
        await waitFor(() => {
          expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
        });
        const kept = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
        expect(kept.value).toBe('Typed while it uploaded.');
      });

      it('carries the edited text, not the text that failed', async () => {
        const view = proposed([], {}, 0);
        const upload = waiting();
        serve(...failingSend(view, upload));
        const { router } = renderApp('/shape');
        const input = await screen.findByRole('textbox', { name: 'Message' });
        await screen.findByRole('list', { name: 'Recent conversations' });
        dropOn(input, brief());
        send(input, 'Move density ahead of the scrollbars.');
        expect(await screen.findByText('The daemon is restarting')).toBeTruthy();
        fireEvent.change(input, { target: { value: 'Move density behind the scrollbars.' } });
        upload.release();
        await waitFor(() => {
          expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
        });
        const kept = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
        expect(kept.value).toBe('Move density behind the scrollbars.');
      });

      it('leaves the input empty, with no old failure, when the builder cleared it', async () => {
        const view = proposed([], {}, 0);
        const upload = waiting();
        serve(...failingSend(view, upload));
        const { router } = renderApp('/shape');
        const input = await screen.findByRole('textbox', { name: 'Message' });
        await screen.findByRole('list', { name: 'Recent conversations' });
        dropOn(input, brief());
        send(input, 'Move density ahead of the scrollbars.');
        expect(await screen.findByText('The daemon is restarting')).toBeTruthy();
        fireEvent.change(input, { target: { value: '' } });
        upload.release();
        await waitFor(() => {
          expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
        });
        const kept = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
        expect(kept.value).toBe('');
        expect(screen.queryByText('The daemon is restarting')).toBeNull();
      });

      describe('when the builder edits the text of a send still in flight', () => {
        const heldSend = (
          view: ShapeViewDto,
          message: ReturnType<typeof waiting>,
          upload: ReturnType<typeof waiting>,
          answer: () => Response,
        ) => [
          ...conversation(view),
          created(view),
          http.post(daemonUrl('/shapes/:shapeId/messages'), async () => {
            await message.held;
            return answer();
          }),
          http.post(daemonUrl('/shapes/:shapeId/files'), async () => {
            await upload.held;
            return HttpResponse.json(fileDto(view), { status: 201 });
          }),
        ];

        const editThenOpen = async (view: ShapeViewDto, upload: ReturnType<typeof waiting>) => {
          const { router } = renderApp('/shape');
          const input = await screen.findByRole('textbox', { name: 'Message' });
          await screen.findByRole('list', { name: 'Recent conversations' });
          dropOn(input, brief());
          send(input, 'Move density ahead');
          fireEvent.change(input, { target: { value: 'Move density ahead, and thin the bars.' } });
          upload.release();
          await waitFor(() => {
            expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
          });
          const kept = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
          await waitFor(() => {
            expect(kept.value).toBe('Move density ahead, and thin the bars.');
          });
          return kept;
        };

        it('carries the input as it stands when the send succeeds', async () => {
          const view = proposed([], {}, 0);
          const message = waiting();
          const upload = waiting();
          let answered = false;
          serve(
            ...heldSend(view, message, upload, () => {
              answered = true;
              return HttpResponse.json(shapeMessageDto(view.shape.id), { status: 202 });
            }),
          );
          const kept = await editThenOpen(view, upload);
          message.release();
          await waitFor(() => {
            expect(answered).toBe(true);
          });
          expect(kept.value).toBe('Move density ahead, and thin the bars.');
        });

        it('keeps the edits and shows why when the send fails', async () => {
          const view = proposed([], {}, 0);
          const message = waiting();
          const upload = waiting();
          serve(
            ...heldSend(view, message, upload, () =>
              HttpResponse.json(
                { error: 'unavailable', message: 'The daemon is restarting' },
                { status: 503 },
              ),
            ),
          );
          const kept = await editThenOpen(view, upload);
          message.release();
          expect(await screen.findByText('The daemon is restarting')).toBeTruthy();
          expect(kept.value).toBe('Move density ahead, and thin the bars.');
        });
      });

      it('keeps the text and the reason when the upload lands as the send fails', async () => {
        const view = proposed([], {}, 0);
        const message = waiting();
        const upload = waiting();
        const reached = { message: false, upload: false };
        serve(
          ...conversation(view),
          created(view),
          http.post(daemonUrl('/shapes/:shapeId/messages'), async () => {
            reached.message = true;
            await message.held;
            return HttpResponse.json(
              { error: 'unavailable', message: 'The daemon is restarting' },
              { status: 503 },
            );
          }),
          http.post(daemonUrl('/shapes/:shapeId/files'), async () => {
            reached.upload = true;
            await upload.held;
            return HttpResponse.json(fileDto(view), { status: 201 });
          }),
        );
        const { router } = renderApp('/shape');
        const input = await screen.findByRole('textbox', { name: 'Message' });
        await screen.findByRole('list', { name: 'Recent conversations' });
        dropOn(input, brief());
        send(input, 'Move density ahead of the scrollbars.');
        await waitFor(() => {
          expect(reached).toEqual({ message: true, upload: true });
        });
        message.release();
        upload.release();
        await waitFor(() => {
          expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
        });
        expect(await screen.findByText('The daemon is restarting')).toBeTruthy();
        const kept = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
        expect(kept.value).toBe('Move density ahead of the scrollbars.');
      });

      it('carries the text once, however many uploads finish after the builder left', async () => {
        const view = proposed([], {}, 0);
        const first = waiting();
        const second = waiting();
        serve(
          ...conversation(view),
          created(view),
          accepted(view),
          http.post(daemonUrl('/shapes/:shapeId/files'), async ({ request }) => {
            if (new URL(request.url).searchParams.get('name') === 'brief.md') {
              await first.held;
              return HttpResponse.json(fileDto(view), { status: 201 });
            }
            await second.held;
            // A refusal, because that is what shows the new input has heard this upload finish.
            return refused('notes.md isn’t really Markdown');
          }),
        );
        const { router } = renderApp('/shape');
        const input = await screen.findByRole('textbox', { name: 'Message' });
        await screen.findByRole('list', { name: 'Recent conversations' });
        fireEvent.change(input, { target: { value: 'Thin the scrollbars.' } });
        dropOn(input, brief());
        dropOn(input, [new File(['# Hi'], 'notes.md', { type: 'text/markdown' })]);
        await waitFor(() => {
          expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
        });
        await router.navigate({ to: '/shape/$shapeId', params: { shapeId: view.shape.id } });
        first.release();
        const opened = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
        await waitFor(() => {
          expect(opened.value).toBe('Thin the scrollbars.');
        });
        fireEvent.keyDown(opened, { key: 'Enter', metaKey: true });
        await waitFor(() => {
          expect(opened.value).toBe('');
        });
        second.release();
        expect(await screen.findByText('notes.md isn’t really Markdown')).toBeTruthy();
        expect(opened.value).toBe('');
      });
    });

    it('does not pull the builder back when the later one finishes after they moved on', async () => {
      const view = proposed([], {}, 0);
      const upload = waiting();
      serve(
        ...conversation(view),
        created(view),
        accepted(view),
        http.post(daemonUrl('/shapes/:shapeId/files'), async () => {
          await upload.held;
          return HttpResponse.json(fileDto(view), { status: 201 });
        }),
      );
      const { router } = renderApp('/shape');
      const input = await screen.findByRole('textbox', { name: 'Message' });
      await screen.findByRole('list', { name: 'Recent conversations' });
      dropOn(input, brief());
      send(input, 'Move density ahead of the scrollbars.');
      await waitFor(() => {
        expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
      });
      await router.navigate({ to: '/shape' });
      upload.release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(router.state.location.pathname).toBe('/shape');
    });
  });

  it('uploads a pasted screenshot under a name the daemon accepts', async () => {
    const view = proposed([], {}, 0);
    const up = upload();
    serve(...conversation(view), up.handler);
    open(view);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File(['png'], '', { type: 'image/png' })],
        getData: () => '',
      },
    });
    await waitFor(() => {
      expect(up.seen.map((s) => s.name)).toEqual(['pasted-image.png']);
    });
  });

  it('pastes text as text, even when the clipboard carries a file too', async () => {
    const view = proposed([], {}, 0);
    const up = upload();
    serve(...conversation(view), up.handler);
    open(view);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File(['png'], 'cells.png', { type: 'image/png' })],
        getData: () => '1\t2',
      },
    });
    expect(up.seen).toEqual([]);
  });

  it('refuses a type that is not accepted with the reason, sending nothing', async () => {
    const view = proposed([], {}, 0);
    const up = upload();
    serve(...conversation(view), up.handler);
    open(view);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    dropOn(input, [new File(['#!/bin/sh'], 'run.sh')]);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(
      /run\.sh can't be added.*Markdown, plain text, PDF, PNG, JPEG or WebP/,
    );
    expect(up.seen).toEqual([]);
  });

  it('says what the daemon said when it refuses a file the input accepted', async () => {
    const view = proposed([], {}, 0);
    serve(
      ...conversation(view),
      http.post(daemonUrl('/shapes/:shapeId/files'), () =>
        HttpResponse.json(
          { error: 'invalid', message: 'fake.png isn’t really a PNG' },
          { status: 400 },
        ),
      ),
    );
    open(view);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    dropOn(input, [new File(['x'], 'fake.png', { type: 'image/png' })]);
    expect(await screen.findByText('fake.png isn’t really a PNG')).toBeTruthy();
  });

  it('names the files already in the conversation under the input', async () => {
    const base = proposed([], {}, 0);
    const view = {
      ...base,
      files: [
        {
          id: mintId('ShapeFile'),
          shapeId: base.shape.id,
          name: 'brief.md',
          mediaType: 'text/markdown',
          size: 4,
          storedPath: '/data/shapes/x/files/brief.md',
          createdAt: '2026-11-02T12:00:00.000Z',
        },
      ],
    };
    serve(...conversation(view));
    open(view);
    expect((await screen.findByLabelText('Files in the conversation')).textContent).toBe(
      'brief.md',
    );
  });
});

describe('dictation', () => {
  // macOS dictation types into a native text control through the system's text input client. It needs
  // a plain <textarea>: not a contenteditable, nothing that swallows input events, and no attribute
  // that turns the system's input services off. Whether the Tauri window's WKWebView lets it speak
  // is checked by hand on a Mac (docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §14).
  it('is a native textarea that takes the text the system inserts', async () => {
    const view = proposed([], {}, 0);
    serve(...conversation(view));
    open(view);
    const input = await screen.findByRole('textbox', { name: 'Message' });
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.closest('[contenteditable]')).toBeNull();
    for (const attribute of ['readonly', 'disabled', 'inputmode', 'autocorrect', 'spellcheck']) {
      expect(input.hasAttribute(attribute), attribute).toBe(false);
    }
    // Dictation inserts its text as an input event on the control; the draft follows.
    const beforeInput = fireEvent(
      input,
      new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: 'Thin scrollbars',
        cancelable: true,
      }),
    );
    expect(beforeInput).toBe(true);
    fireEvent.change(input, { target: { value: 'Thin scrollbars' } });
    expect((input as HTMLTextAreaElement).value).toBe('Thin scrollbars');
  });
});
