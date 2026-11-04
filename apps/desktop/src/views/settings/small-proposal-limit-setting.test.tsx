import { SmallProposalLimitDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { SMALL_PROPOSAL_LIMIT_LABEL } from './small-proposal-limit-setting';

describe('Settings › General › Small proposals', () => {
  it('shows the saved limit and sends the edited one, zero included', async () => {
    const put: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects/:projectId/small-proposal-limit'), () =>
        HttpResponse.json({ limit: 1200 }),
      ),
      http.put(daemonUrl('/projects/:projectId/small-proposal-limit'), async ({ request }) => {
        const body = SmallProposalLimitDto.parse(await request.json());
        put.push(body);
        return HttpResponse.json(body);
      }),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    const box = await screen.findByRole('textbox', { name: SMALL_PROPOSAL_LIMIT_LABEL });
    await waitFor(() => {
      expect(box).toHaveProperty('value', '1200');
    });
    const save = screen.getByRole('button', { name: 'Save proposal limit' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(box, { target: { value: '0' } });
    fireEvent.click(save);
    await waitFor(() => {
      expect(put).toEqual([{ limit: 0 }]);
    });
  });

  it('stays empty with Save disabled when cleared, until a number is typed', async () => {
    const put: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects/:projectId/small-proposal-limit'), () =>
        HttpResponse.json({ limit: 1200 }),
      ),
      http.put(daemonUrl('/projects/:projectId/small-proposal-limit'), async ({ request }) => {
        const body = SmallProposalLimitDto.parse(await request.json());
        put.push(body);
        return HttpResponse.json(body);
      }),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    const box = await screen.findByRole('textbox', { name: SMALL_PROPOSAL_LIMIT_LABEL });
    await waitFor(() => {
      expect(box).toHaveProperty('value', '1200');
    });
    const save = screen.getByRole('button', { name: 'Save proposal limit' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '5' } });
    expect(box).toHaveProperty('value', '5');
    fireEvent.change(box, { target: { value: '' } });
    expect(box).toHaveProperty('value', '');
    expect(save).toHaveProperty('disabled', true);
    fireEvent.blur(box);
    expect(box).toHaveProperty('value', '');
    expect(save).toHaveProperty('disabled', true);
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '0' } });
    expect(box).toHaveProperty('value', '0');
    expect(save).toHaveProperty('disabled', false);
    fireEvent.click(save);
    await waitFor(() => {
      expect(put).toEqual([{ limit: 0 }]);
    });
  });
});
