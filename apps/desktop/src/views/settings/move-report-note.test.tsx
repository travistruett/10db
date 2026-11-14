import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { MoveReportNote } from './move-report-note';

describe('the move report', () => {
  it('lists what could not carry over, and Dismiss removes it', async () => {
    let dismissed = 0;
    let report = [
      { setting: 'A pattern on areas', value: 'docs/**', why: 'Playbook cells have no areas.' },
    ];
    server.use(
      http.get(daemonUrl('/playbook/move-report'), () => HttpResponse.json(report)),
      http.delete(daemonUrl('/playbook/move-report'), () => {
        dismissed += 1;
        report = [];
        return new HttpResponse(null, { status: 204 });
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(<MoveReportNote />);
    const note = within(
      await screen.findByRole('region', { name: 'Some settings could not carry over' }),
    );
    expect(note.getByText(/A pattern on areas/)).toBeTruthy();
    expect(note.getByText(/Playbook cells have no areas/)).toBeTruthy();
    fireEvent.click(note.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('region', { name: 'Some settings could not carry over' }),
      ).toBeNull();
    });
    expect(dismissed).toBe(1);
  });

  it('shows nothing when everything moved', async () => {
    server.use(...baseHandlers());
    const { queryClient } = renderWithDaemon(<MoveReportNote />);
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    cleanup();
    expect(screen.queryByRole('region')).toBeNull();
  });
});
