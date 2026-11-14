import { SmallProposalLimitDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { SMALL_PROPOSAL_LIMIT_LABEL } from './small-proposal-limit-setting';

describe('Settings › Planning › Small proposals', () => {
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
      ...baseHandlers(),
    );
    renderApp('/settings/planning');
    const box = await screen.findByRole('textbox', { name: SMALL_PROPOSAL_LIMIT_LABEL });
    await waitFor(() => {
      expect(box).toHaveProperty('value', '1200');
    });
    const save = screen.getByRole('button', { name: 'Save Proposal Limit' });
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
      ...baseHandlers(),
    );
    renderApp('/settings/planning');
    const box = await screen.findByRole('textbox', { name: SMALL_PROPOSAL_LIMIT_LABEL });
    await waitFor(() => {
      expect(box).toHaveProperty('value', '1200');
    });
    const save = screen.getByRole('button', { name: 'Save Proposal Limit' });
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

  it.each([
    { name: 'a 5 typed after a saved 0', saved: 0, typed: '05', shown: '5', sent: 5 },
    { name: 'a 0 typed before a saved 1200', saved: 1200, typed: '01200', shown: '1200' },
    { name: 'a 0 typed after a saved 0', saved: 0, typed: '00', shown: '0' },
    { name: 'a second 0 replacing a saved 1200', saved: 1200, typed: '00', shown: '0', sent: 0 },
  ])('keeps the number with leading zeros: $name', async ({ saved, typed, shown, sent }) => {
    const put: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects/:projectId/small-proposal-limit'), () =>
        HttpResponse.json({ limit: saved }),
      ),
      http.put(daemonUrl('/projects/:projectId/small-proposal-limit'), async ({ request }) => {
        const body = SmallProposalLimitDto.parse(await request.json());
        put.push(body);
        return HttpResponse.json(body);
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/planning');
    const box = await screen.findByRole('textbox', { name: SMALL_PROPOSAL_LIMIT_LABEL });
    await waitFor(() => {
      expect(box).toHaveProperty('value', String(saved));
    });
    const save = screen.getByRole('button', { name: 'Save Proposal Limit' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: typed } });
    expect(box).not.toHaveProperty('value', '');
    expect(save).toHaveProperty('disabled', sent === undefined);
    fireEvent.blur(box);
    expect(box).toHaveProperty('value', shown);
    expect(save).toHaveProperty('disabled', sent === undefined);
    if (sent === undefined) return;
    fireEvent.click(save);
    await waitFor(() => {
      expect(put).toEqual([{ limit: sent }]);
    });
  });
});
