import { mintId } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemonAndRouter, server } from '../../test/daemon';
import { PlannedIn } from './planned-in';

// A goal Convert made from a Plan names that Plan and leads to its record; a goal filed by hand says
// nothing.

describe('Planned in', () => {
  it('a goal from a Plan says Planned in with its title and links to the record', async () => {
    const goalId = mintId('Goal');
    const shapeId = mintId('Shape');
    server.use(
      http.get(daemonUrl('/goals/:goalId/shape'), () =>
        HttpResponse.json({ shapeId, title: 'Remote host' }),
      ),
      ...baseHandlers(),
    );
    const { router } = await renderWithDaemonAndRouter(<PlannedIn goalId={goalId} />);
    const link = await screen.findByRole('button', { name: 'Remote host' });
    expect(link.closest('p')?.textContent).toBe('Planned in Remote host');
    fireEvent.click(link);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/shape/${shapeId}/record`);
    });
  });

  it('a goal filed by hand says nothing', async () => {
    const { queryClient } = await renderWithDaemonAndRouter(<PlannedIn goalId={mintId('Goal')} />);
    server.use(...baseHandlers());
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(screen.queryByText(/Planned in/)).toBeNull();
  });
});
