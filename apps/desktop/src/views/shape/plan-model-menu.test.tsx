import type { ShapeViewDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { modelEffortDto, modelRowDto } from '../../test/model-fixtures';
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

/** Records each model and effort sent to the daemon and answers with the conversation. */
function acceptModels(view: ShapeViewDto, sent: unknown[]): RequestHandler {
  return http.put(daemonUrl('/shapes/:shapeId/model'), async ({ request }) => {
    const body = (await request.json()) as { model: string | null; effort: string | null };
    sent.push(body);
    return HttpResponse.json({ ...view.shape, model: body.model, effort: body.effort });
  });
}

const chip = (): Promise<HTMLElement> => screen.findByRole('button', { name: 'Model and effort' });

describe('the Plan composer’s model chip', () => {
  const rows = [
    modelRowDto({
      model: 'claude-fable-5-1',
      name: 'Fable',
      tier: 'capable',
      efforts: [modelEffortDto({ effort: 'max' }), modelEffortDto({ effort: 'high' })],
    }),
  ];

  it('names the model and effort in use', async () => {
    const view = conversation({}, 'claude-fable-5-1');
    view.shape.effort = 'max';
    serve(
      view,
      http.get(daemonUrl('/models'), () => HttpResponse.json(rows)),
    );
    renderApp(`/shape/${view.shape.id}`);
    await waitFor(async () => {
      expect((await chip()).textContent).toBe('Fable Max');
    });
  });

  it('sends an effort picked for the model in use, which applies from the next turn', async () => {
    const view = conversation({}, 'claude-fable-5-1');
    const sent: unknown[] = [];
    serve(
      view,
      http.get(daemonUrl('/models'), () => HttpResponse.json(rows)),
      acceptModels(view, sent),
    );
    renderApp(`/shape/${view.shape.id}`);
    await waitFor(async () => {
      expect((await chip()).textContent).toBe('Fable');
    });
    fireEvent.click(await chip());
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: /Effort/, hidden: true }), {
      key: 'ArrowRight',
    });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'High', hidden: true }));
    await waitFor(() => {
      expect(sent).toEqual([{ model: 'claude-fable-5-1', effort: 'high' }]);
    });
  });

  it('is off while a turn runs', async () => {
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
    expect(((await chip()) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the daemon refusal beside the chip', async () => {
    const view = conversation();
    serve(
      view,
      http.get(daemonUrl('/models'), () => HttpResponse.json(rows)),
      http.put(daemonUrl('/shapes/:shapeId/model'), () =>
        HttpResponse.json(
          { error: 'conflict', message: 'A turn is running: change the model after it ends.' },
          { status: 409 },
        ),
      ),
    );
    renderApp(`/shape/${view.shape.id}`);
    fireEvent.click(await chip());
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Fable/, hidden: true }));
    expect(
      await screen.findByText('A turn is running: change the model after it ends.'),
    ).toBeTruthy();
  });

  it('is hidden when the account offers no model', async () => {
    const view = conversation({ models: { default: null, offered: [] } });
    serve(view);
    renderApp(`/shape/${view.shape.id}`);
    await screen.findByRole('textbox', { name: 'Message' });
    expect(screen.queryByRole('button', { name: 'Model and effort' })).toBeNull();
  });
});
