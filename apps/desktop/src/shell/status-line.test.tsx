import { StatusDto } from '@10db/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../test/daemon';

const line = (
  key: string,
  text: string,
  kind: 'admission_hold' | 'model_list_wait',
  busiest: string[] = [],
) => ({
  key,
  kind,
  label: text.split(':')[0] ?? text,
  line: text,
  details: `Details of ${text}.`,
  since: '2026-11-18T12:00:00.000Z',
  busiest,
  culprits: [],
});

function serve(status: unknown) {
  server.use(
    http.get(daemonUrl('/status'), () => HttpResponse.json(StatusDto.parse(status))),
    ...baseHandlers(),
  );
}

// The hovercard listens for the native mouseenter, which does not bubble from the bar to the box that carries it (the progress root is in between).
const hoverTarget = (bar: HTMLElement): HTMLElement => bar.parentElement?.parentElement ?? bar;

describe('the status line in the rail', () => {
  it('draws no bar while the Mac is below half busy', async () => {
    serve({ lines: [], busy: { level: 0.4, holding: false } });
    renderApp('/board');
    await screen.findByRole('navigation').catch(() => undefined);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('draws a bar and says the Mac is busy, with no numbers, when it is half busy or more', async () => {
    serve({ lines: [], busy: { level: 0.7, holding: false } });
    renderApp('/board');
    const bar = await screen.findByRole('progressbar', { name: 'Mac busy' });
    fireEvent.mouseEnter(hoverTarget(bar));
    expect(await screen.findByText(/Your Mac is busy\. 10db keeps working/)).toBeTruthy();
    expect(screen.queryByText(/Busiest right now/)).toBeNull();
  });

  it('says 10db is holding, and what is busiest in plain words, while it holds', async () => {
    serve({
      lines: [line('overload', 'Holding new lanes', 'admission_hold', ['Docker', 'file indexing'])],
      busy: { level: 1, holding: true },
    });
    renderApp('/board');
    fireEvent.mouseEnter(
      hoverTarget(await screen.findByRole('progressbar', { name: 'Mac too busy' })),
    );
    expect(await screen.findByText(/too busy to start new work/)).toBeTruthy();
    expect(screen.getByText('Busiest right now: Docker, file indexing')).toBeTruthy();
  });

  it('keeps the short label and the details popover for a hold that is not the load', async () => {
    serve({
      lines: [line('wait', 'Codex plan is waiting for its model list', 'model_list_wait')],
      busy: null,
    });
    renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: /Codex plan is waiting/ }));
    expect(await screen.findByText(/Details of Codex plan is waiting/)).toBeTruthy();
  });
});
