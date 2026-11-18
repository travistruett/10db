import { StatusDto } from '@10db/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../test/daemon';

const line = (
  key: string,
  text: string,
  culprits: { name: string; cpuPct: number; owner: string }[] = [],
) => ({
  key,
  kind: 'admission_hold' as const,
  label: text.split(':')[0] ?? text,
  line: text,
  details: `Details of ${text}.`,
  since: '2026-11-18T12:00:00.000Z',
  culprits,
});

describe('the status line in the rail', () => {
  it('names the oldest hold, says how many more, and opens every hold’s details and busiest processes', async () => {
    server.use(
      http.get(daemonUrl('/status'), () =>
        HttpResponse.json(
          StatusDto.parse({
            lines: [
              line('overload', 'Holding new lanes: the Mac is overloaded (load 23 on 10 cores)', [
                { name: 'sh', cpuPct: 99, owner: 'not 10db’s' },
              ]),
              line('wait', 'Codex plan is waiting for its model list'),
            ],
          }),
        ),
      ),
      ...baseHandlers(),
    );
    renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: /Holding new lanes.*\+1 more/ }));
    expect(await screen.findByText(/Details of Holding new lanes/)).toBeTruthy();
    expect(screen.getByText('sh: 99% of a core, not 10db’s')).toBeTruthy();
    expect(screen.getByText(/Details of Codex plan is waiting/)).toBeTruthy();
  });
});
