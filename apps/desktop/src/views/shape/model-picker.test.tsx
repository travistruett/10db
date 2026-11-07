import type { ShapeViewDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { modelRowDto } from '../../test/model-fixtures';
import { shapeDto, shapeMessageDto, shapeViewDto } from '../../test/shape-fixtures';

const project = projectViewDto();

function conversation(
  extra: Partial<ShapeViewDto> = {},
  model: string | null = null,
): ShapeViewDto {
  const shape = shapeDto({ projectId: project.id, model });
  return shapeViewDto({ shape, messages: [shapeMessageDto(shape.id)], ...extra });
}

function serve(view: ShapeViewDto, ...overrides: RequestHandler[]): void {
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([view.shape])),
    http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(view)),
    ...overrides,
    ...baseHandlers(),
  );
}

/** Opens the picker's list and returns it. */
async function openList(): Promise<HTMLElement> {
  const input = await screen.findByRole('combobox', { name: 'Model' });
  fireEvent.click(input);
  return waitFor(() => {
    const id = input.getAttribute('aria-controls');
    const list = id === null ? null : document.getElementById(id);
    expect(list).not.toBeNull();
    return list ?? document.body;
  });
}

/** Records each model sent to the daemon and answers with the conversation. */
function acceptModels(view: ShapeViewDto, sent: unknown[]): RequestHandler {
  return http.put(daemonUrl('/shapes/:shapeId/model'), async ({ request }) => {
    const body = (await request.json()) as { model: string | null };
    sent.push(body);
    return HttpResponse.json({ ...view.shape, model: body.model });
  });
}

describe('the Plan conversation model picker', () => {
  it('offers the default and every model the account lists by tier, Unknown ones last, and shows the pick', async () => {
    const view = conversation({}, 'claude-sonnet-5-5');
    serve(view);
    renderApp(`/shape/${view.shape.id}`);
    const list = await openList();
    const names = within(list)
      .getAllByRole('option', { hidden: true })
      .map((o) => o.textContent);
    expect(names).toEqual([
      'Default (claude-opus-5-5)',
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-fable-5-1',
      'house-model',
    ]);
    const headings = ['Fast models', 'Balanced models', 'Strongest models', 'Unknown tier'];
    for (const heading of headings) expect(within(list).getByText(heading)).toBeTruthy();
    const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Model' });
    expect(input.value).toBe('claude-sonnet-5-5');
  });

  it('names each model as Settings does, marks a replaced or Unknown one, and groups by the shared tier labels', async () => {
    const view = conversation();
    serve(
      view,
      http.get(daemonUrl('/models'), () =>
        HttpResponse.json([
          modelRowDto({ model: 'claude-haiku-5-5', name: 'Haiku', tier: 'fast' }),
          modelRowDto({
            model: 'claude-sonnet-5-5',
            name: 'Sonnet',
            tier: 'balanced',
            status: 'superseded',
          }),
          modelRowDto({ model: 'claude-opus-5-5', name: 'Opus', tier: 'strongest' }),
          modelRowDto({
            model: 'house-model',
            name: 'House',
            tier: null,
            status: 'unknown',
            maker: null,
            family: null,
          }),
        ]),
      ),
    );
    renderApp(`/shape/${view.shape.id}`);
    const list = await openList();
    await waitFor(() => {
      expect(
        within(list)
          .getAllByRole('option', { hidden: true })
          .map((o) => o.textContent),
      ).toEqual([
        'Default (Opus)',
        'Haiku',
        'Sonnet (superseded)',
        'Opus',
        'claude-fable-5-1',
        'House (Unknown)',
      ]);
    });
    for (const heading of ['Fast models', 'Balanced models', 'Strongest models', 'Unknown tier'])
      expect(within(list).getByText(heading)).toBeTruthy();
  });

  it('keeps a pick the account no longer lists, marked, rather than reading as the default', async () => {
    const view = conversation({}, 'claude-opus-4-8');
    serve(view);
    renderApp(`/shape/${view.shape.id}`);
    const input = await screen.findByRole<HTMLInputElement>('combobox', { name: 'Model' });
    expect(input.value).toBe('claude-opus-4-8 (not offered)');
  });

  it('sends the chosen model, and null for the default', async () => {
    const view = conversation({}, 'claude-sonnet-5-5');
    const sent: unknown[] = [];
    serve(view, acceptModels(view, sent));
    renderApp(`/shape/${view.shape.id}`);
    fireEvent.click(
      within(await openList()).getByRole('option', { name: 'claude-fable-5-1', hidden: true }),
    );
    await waitFor(() => {
      expect(sent).toEqual([{ model: 'claude-fable-5-1' }]);
    });
    fireEvent.click(
      within(await openList()).getByRole('option', {
        name: 'Default (claude-opus-5-5)',
        hidden: true,
      }),
    );
    await waitFor(() => {
      expect(sent).toEqual([{ model: 'claude-fable-5-1' }, { model: null }]);
    });
  });

  it('is disabled with a reason while a turn runs', async () => {
    const view = conversation({
      turn: {
        running: true,
        queued: 0,
        proposing: false,
        rehearsing: false,
        waitingForUpdate: false,
      },
    });
    serve(view);
    renderApp(`/shape/${view.shape.id}`);
    const input = await screen.findByRole<HTMLInputElement>('combobox', { name: 'Model' });
    expect(input.disabled).toBe(true);
    expect(screen.getByText('Change the model between turns')).toBeTruthy();
  });

  it('shows the daemon refusal beside the control', async () => {
    const view = conversation();
    serve(
      view,
      http.put(daemonUrl('/shapes/:shapeId/model'), () =>
        HttpResponse.json(
          { error: 'conflict', message: 'A turn is running: change the model after it ends.' },
          { status: 409 },
        ),
      ),
    );
    renderApp(`/shape/${view.shape.id}`);
    fireEvent.click(
      within(await openList()).getByRole('option', { name: 'claude-fable-5-1', hidden: true }),
    );
    expect(
      await screen.findByText('A turn is running: change the model after it ends.'),
    ).toBeTruthy();
  });

  it('is hidden when the account offers no model', async () => {
    const view = conversation({ models: { default: null, offered: [] } });
    serve(view);
    renderApp(`/shape/${view.shape.id}`);
    await screen.findByRole('textbox', { name: 'Message' });
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  });
});
