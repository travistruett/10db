import { ShapeJevSettingDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { SHAPE_JEV_LABEL } from './shape-jev-setting';

// Shape spec §9: a project's opt-in, off by default, names where the messages go.

describe('Settings › Planning › Send brainstorm messages to fast models', () => {
  it('is off by default, names OpenRouter, and sends the change', async () => {
    const put: unknown[] = [];
    server.use(
      http.put(daemonUrl('/projects/:projectId/shape-jev'), async ({ request }) => {
        const body = ShapeJevSettingDto.parse(await request.json());
        put.push(body);
        return HttpResponse.json(body);
      }),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderApp('/settings/planning');
    const toggle = await screen.findByRole('switch', { name: SHAPE_JEV_LABEL });
    await waitFor(() => {
      expect(toggle).toHaveProperty('disabled', false);
    });
    expect(toggle).toHaveProperty('checked', false);
    expect(screen.getByText(/OpenRouter and the model's provider/)).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(put).toEqual([{ enabled: true }]);
    });
    await waitFor(() => {
      expect(toggle).toHaveProperty('checked', true);
    });
  });
});
