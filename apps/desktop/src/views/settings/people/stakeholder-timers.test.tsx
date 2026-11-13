import { StakeholderTimersDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../../test/daemon';
import { StakeholderTimers } from './stakeholder-timers';

function serve(initial: StakeholderTimersDto = { remindAfterHours: 4, returnAfterHours: 8 }) {
  const saved: unknown[] = [];
  server.use(
    http.get(daemonUrl('/stakeholders/timers'), () => HttpResponse.json(initial)),
    http.put(daemonUrl('/stakeholders/timers'), async ({ request }) => {
      const body: unknown = await request.json();
      saved.push(body);
      return HttpResponse.json(StakeholderTimersDto.parse(body));
    }),
    ...baseHandlers(),
  );
  renderWithDaemon(<StakeholderTimers />);
  return saved;
}

describe('StakeholderTimers', () => {
  it('shows 4 and 8 hours and says the clock is real time', async () => {
    serve();
    expect(await screen.findByLabelText('Remind after (hours)')).toHaveProperty('value', '4');
    expect(screen.getByLabelText('Back to you after (hours)')).toHaveProperty('value', '8');
    expect(screen.getByText(/fires when it wakes/)).toBeTruthy();
  });

  it('a change saves', async () => {
    const saved = serve();
    const back = await screen.findByLabelText('Back to you after (hours)');
    fireEvent.change(back, { target: { value: '12' } });
    fireEvent.blur(back);
    await waitFor(() => {
      expect(saved).toEqual([{ remindAfterHours: 4, returnAfterHours: 12 }]);
    });
  });

  it('takes whole hours only', async () => {
    const saved = serve();
    const back = await screen.findByLabelText('Back to you after (hours)');
    fireEvent.change(back, { target: { value: '12.5' } });
    fireEvent.blur(back);
    await waitFor(() => {
      expect(
        saved.every((s) => Number.isInteger((s as { returnAfterHours: number }).returnAfterHours)),
      ).toBe(true);
    });
    expect(screen.getByLabelText('Back to you after (hours)')).toHaveProperty('value', '12');
  });

  it('turning the reminder on picks a value below the return', async () => {
    const saved = serve({ remindAfterHours: null, returnAfterHours: 3 });
    fireEvent.click(await screen.findByRole('switch', { name: 'Send a reminder' }));
    await waitFor(() => {
      expect(saved).toEqual([{ remindAfterHours: 2, returnAfterHours: 3 }]);
    });
  });

  it('the reminder can be turned off', async () => {
    const saved = serve();
    fireEvent.click(await screen.findByRole('switch', { name: 'Send a reminder' }));
    await waitFor(() => {
      expect(saved).toEqual([{ remindAfterHours: null, returnAfterHours: 8 }]);
    });
  });

  it("shows the daemon's refusal when the reminder is not before the return", async () => {
    server.use(
      http.put(daemonUrl('/stakeholders/timers'), () =>
        HttpResponse.json(
          { error: 'invalid', message: 'Remind before the question goes back to you' },
          { status: 400 },
        ),
      ),
    );
    serve();
    const remind = await screen.findByLabelText('Remind after (hours)');
    fireEvent.change(remind, { target: { value: '9' } });
    fireEvent.blur(remind);
    expect(await screen.findByText(/Remind before the question goes back to you/)).toBeTruthy();
  });
});
